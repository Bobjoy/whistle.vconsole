/**
 * The HTTP surface: device panel, MCP-over-HTTP, probe assets, SSE feed and the
 * token gateway — on one port (9527), for every start-up form.
 *
 * `lib/runtime.js` (whistle) and `src/cli.ts` (standalone `v2 start`) both call
 * `createHttpService()`; it owns the probe hub too, so an entry is one call.
 * Nothing in here touches a whistle API — that is what makes standalone work.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBackend, getLanAddresses, hasAccess, createMcpServer, VERSION } from './index.js';
import type { StartOptions } from './index.js';
import type { ToolBackend } from './mcpServer.js';

/** The single HTTP port every form shares (ADR-002). */
export const MCP_HTTP_PORT = 9527;

export interface HttpServiceConfig extends StartOptions {
  /** HTTP port (default MCP_HTTP_PORT); the hub WS port stays `port` */
  httpPort?: number;
  /**
   * The panel markup. `lib/panel.js` is a plain CommonJS template of
   * hand-rolled HTML+JS that stays outside the bundle, so the caller passes it in.
   */
  panelHtml?: string;
  /** probe bundle served at /probe.js (default: `dist/probe.js` beside this bundle) */
  probeBundlePath?: string;
}

export interface HttpService {
  /** the HTTP port being served */
  port: number;
  hubPort: number;
  mode: 'hub' | 'proxy';
  token: string;
  backend: ToolBackend;
  server: http.Server;
  stop(): void;
}

/**
 * SSE hub for the panel (GET /api/events): instead of the panel polling every
 * second, the hub's onData/onSessionEvent hooks schedule a debounced push with
 * a fresh sessions snapshot + which session/kinds changed. Data itself still
 * flows through /api/tool — this is a change-notification channel.
 */
function createSseHub(backend: ToolBackend) {
  const clients = new Set<http.ServerResponse>();
  const pending = new Map<string, Set<string>>(); // sessionId -> Set<kind>
  let timer: ReturnType<typeof setTimeout> | null = null;

  const notify = (sessionId?: string, kind?: string) => {
    if (sessionId) {
      if (!pending.has(sessionId)) { pending.set(sessionId, new Set()); }
      pending.get(sessionId)!.add(kind || 'sessions');
    }
    if (!timer) { timer = setTimeout(flush, 200); }
  };

  const flush = async () => {
    timer = null;
    const touched = [...pending].map(([sessionId, kinds]) => ({ sessionId, kinds: [...kinds] }));
    pending.clear();
    if (!clients.size) { return; }
    let sessions: unknown;
    try {
      const r = await backend.handleTool('list_sessions', {});
      sessions = JSON.parse((r.content[0] as { text: string }).text);
    } catch (e) {
      sessions = { error: String((e as Error).message || e) };
    }
    const payload = `data: ${JSON.stringify({ type: 'update', sessions, touched })}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { clients.delete(res); }
    }
  };

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try { res.write(': hb\n\n'); } catch { clients.delete(res); }
    }
  }, 25000);
  if (heartbeat.unref) { heartbeat.unref(); }

  return {
    notify,
    add(res: http.ServerResponse) {
      clients.add(res);
      res.write('retry: 3000\n\n');
    },
    remove(res: http.ServerResponse) { clients.delete(res); },
  };
}

/**
 * The markup whistle prepends to every proxied HTML page (see rules.txt).
 * Whistle fetches this on the dev machine and inlines it, so the page needs no
 * script of its own; the phone only has to reach the LAN probe bundle and hub.
 *
 * The token rides in the ws URL. This file stays unfetch-gated (the phone loads
 * it through the proxy), so the secret only guards against a peer that cannot
 * read our HTTP responses — which is exactly the drive-by case: a web page on
 * another machine can open `ws://192.168.x.x:9528/` but cross-origin rules stop
 * it reading this markup. A host that can curl us was already inside the
 * "same LAN is trusted" boundary this project documents.
 */
export function buildInjectHtml(cfg: { lan: string; hubPort: number; httpPort: number; token: string }): string {
  const probeUrl = `http://${cfg.lan}:${cfg.httpPort}/probe.js`;
  const serverUrl = `ws://${cfg.lan}:${cfg.hubPort}?t=${encodeURIComponent(cfg.token)}`;
  return `<script src="${probeUrl}"></script>
<script>
if (!window.__VCONSOLE_MCP_INJECTED__ && window.VConsole) {
  window.__VCONSOLE_MCP_INJECTED__ = 1;
  try {
    new VConsole({ serverUrl: ${JSON.stringify(serverUrl)} });
  } catch (e) {
    console.warn('[whistle-vconsole] 探针初始化失败:', e);
  }
}
</script>
`;
}

export async function createHttpService(opts: HttpServiceConfig = {}): Promise<HttpService> {
  const log = opts.log || ((msg: string) => console.error(msg));
  const httpPort = Number(opts.httpPort ?? MCP_HTTP_PORT);
  const probeBundlePath = opts.probeBundlePath || path.join(__dirname, 'probe.js');

  // forward declaration: the hub callbacks fire before the SSE hub exists
  let sse: ReturnType<typeof createSseHub> | null = null;
  const { backend, mode, hub, proxy, port, token } = await createBackend({
    ...opts,
    onData: (sessionId, kind) => { if (sse) { sse.notify(sessionId, kind); } },
    onSessionEvent: (event, sessionId) => { if (sse) { sse.notify(sessionId, 'sessions'); } },
  });
  sse = createSseHub(backend);
  log(`whistle-vconsole v${VERSION} ${mode} mode (probe hub on ws port ${port})`);

  const panelHtml = opts.panelHtml || '';
  const lan = (getLanAddresses(port)[0] || {}).address || '127.0.0.1';
  const views = {
    panelHtml,
    token,
    injectHtml: buildInjectHtml({ lan, hubPort: port, httpPort, token }),
  };
  log(`injected probe endpoint: http://${lan}:${httpPort}/probe.js`);
  log(`LAN access needs the token: panel http://${lan}:${httpPort}/?t=${token}`);

  const httpServer = http.createServer((req, res) => {
    handleRequest(backend, views, sse!, req, res, token, probeBundlePath).catch((e) => {
      log(`request error: ${(e as Error)?.stack || e}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: String((e as Error)?.message || e) }));
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(httpPort, '0.0.0.0', () => {
        httpServer.removeListener('error', reject);
        httpServer.on('error', (e) => log(`http server error: ${(e as Error)?.message || e}`));
        resolve();
      });
    });
  } catch (e) {
    try { hub.stop(); } catch { /* noop */ }
    try { proxy?.close(); } catch { /* noop */ }
    throw e;
  }
  log(`panel + MCP endpoint: http://127.0.0.1:${httpPort}/ (MCP: /mcp)`);

  return {
    port: httpPort,
    hubPort: port,
    mode,
    token,
    backend,
    server: httpServer,
    stop() {
      try { hub.stop(); } catch { /* noop */ }
      try { proxy?.close(); } catch { /* noop */ }
      httpServer.close();
      // an open panel holds its SSE socket forever, and `server.close()` never
      // drops established connections — without this the daemon keeps running
      // after `v2 stop` already reported success
      httpServer.closeAllConnections?.();
    },
  };
}

interface Views { panelHtml: string; token: string; injectHtml: string }

async function handleRequest(
  backend: ToolBackend,
  views: Views,
  sse: ReturnType<typeof createSseHub>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  probeBundlePath: string,
): Promise<void> {
  const url = (req.url || '/').split('?')[0];

  // the panel and the probe bundle stay public (a phone loads them through the
  // proxy) and carry no data; every data endpoint needs the token unless it
  // comes from this machine — see hasAccess
  if ((url === '/mcp' || url.startsWith('/api/'))
    && !hasAccess(req.url || '/', req.socket.remoteAddress, token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing or wrong ?t= token (the hub prints it on startup)' }));
    return;
  }

  // --- panel live feed (SSE): change notifications + sessions snapshot -----
  if (req.method === 'GET' && url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    sse.add(res);
    req.on('close', () => sse.remove(res));
    return;
  }

  // --- probe assets, used by the injected rule (see rules.txt) -------------
  if (req.method === 'GET' && url === '/probe.js') {
    let bundle;
    try {
      bundle = fs.readFileSync(probeBundlePath);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`探针产物缺失，请先构建：pnpm --filter @bobjoy/whistle.vconsole build (${probeBundlePath})`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(bundle);
    return;
  }

  if (req.method === 'GET' && url === '/inject.html') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(views.injectHtml);
    return;
  }

  // --- MCP Streamable HTTP (stateless): a fresh McpServer + transport per
  // request, body parsed first (a shared transport stalls the SDK client on
  // initialize)
  if (url === '/mcp') {
    if (req.method !== 'POST') {
      // stateless mode has no SSE stream / session to terminate
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed (POST only in stateless mode)' }));
      return;
    }
    const raw = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(raw.toString() || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }
    const server = createMcpServer(backend, VERSION);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: every POST is independent
      enableJsonResponse: true,
    });
    res.on('close', () => {
      try { transport.close(); } catch { /* noop */ }
      try { server.close(); } catch { /* noop */ }
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
    return;
  }

  // --- panel & internal API ------------------------------------------------
  if (req.method === 'POST' && url === '/api/tool') {
    const body = await readBody(req);
    const { name, args, sessionId } = JSON.parse(body.toString() || '{}');
    if (!name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing tool name' }));
      return;
    }
    const result = await backend.handleTool(name, args || {}, sessionId ? { sessionId } : undefined);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'GET' && url === '/api/sessions') {
    const result = await backend.handleTool('list_sessions', {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end((result.content[0] as { text: string }).text);
    return;
  }

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(views.panelHtml);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

function readBody(req: http.IncomingMessage, limit = 5 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
