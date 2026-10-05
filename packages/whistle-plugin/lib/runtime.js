/**
 * Plugin runtime singleton: boots the hub (or attaches to a running one),
 * the MCP Streamable HTTP endpoint and the debug panel — all inside the
 * whistle process, so everything starts and stops together with `w2 start`.
 *
 * A globalThis flag keeps whistle's hot plugin reloads from double-binding
 * the ports: after an upgrade, `w2 restart` picks up the new code.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  createBackend, createMcpServer, getLanAddresses, VERSION,
} = require('../dist/index.cjs');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const buildPanelHtml = require('./panel');

const MCP_HTTP_PORT = 9527;
const PROBE_BUNDLE = path.join(__dirname, '..', 'dist', 'probe.js');

const state = {
  booted: false,
  readyPromise: null,
  runtime: null,
};

function log(msg) {
  console.error(`[whistle.vconsole] ${msg}`);
}

/** True when something on :9527 already answers like our own panel does. */
function alreadyServing() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: MCP_HTTP_PORT, path: '/api/sessions', timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(res.statusCode === 200 && body.indexOf('"sessions"') >= 0));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function boot() {
  if (state.booted) {
    return state.runtime;
  }
  state.booted = true;
  // Never rethrow: whistle loads this hook in more than one process, and an
  // unhandled rejection here would take the whole proxy down with it.
  state.readyPromise = start().catch(async (e) => {
    if (e && e.code === 'EADDRINUSE' && await alreadyServing()) {
      log(`another whistle process serves :${MCP_HTTP_PORT}, retrying in 10s`);
      state.booted = false; // the owner may die (whistle restarts one process); take over then
      setTimeout(boot, 10000).unref();
      return { port: MCP_HTTP_PORT };
    }
    log(`runtime failed to start: ${(e && e.stack) || e}`);
    state.booted = false; // allow a retry on the next uiServer call
    return { port: MCP_HTTP_PORT };
  });
  state.runtime = { port: MCP_HTTP_PORT, ready: state.readyPromise };
  return state.runtime;
}

/**
 * SSE hub for the panel (GET /api/events): instead of the panel polling every
 * second, the hub's onData/onSessionEvent hooks schedule a debounced push with
 * a fresh sessions snapshot + which session/kinds changed. Data itself still
 * flows through /api/tool — this is a change-notification channel.
 */
function createSseHub(backend) {
  const clients = new Set();
  const pending = new Map(); // sessionId -> Set<kind>
  let timer = null;

  const notify = (sessionId, kind) => {
    if (sessionId) {
      if (!pending.has(sessionId)) { pending.set(sessionId, new Set()); }
      pending.get(sessionId).add(kind);
    }
    if (!timer) { timer = setTimeout(flush, 200); }
  };

  const flush = async () => {
    timer = null;
    const touched = [...pending].map(([sessionId, kinds]) => ({ sessionId, kinds: [...kinds] }));
    pending.clear();
    if (!clients.size) { return; }
    let sessions = null;
    try {
      const r = await backend.handleTool('list_sessions', {});
      sessions = JSON.parse(r.content[0].text);
    } catch (e) {
      sessions = { error: String((e && e.message) || e) };
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
    add(res) {
      clients.add(res);
      res.write('retry: 3000\n\n');
    },
    remove(res) { clients.delete(res); },
  };
}

async function start() {
  // forward declarations: the hub callbacks fire before createSseHub exists
  let sse = null;
  const { backend, mode, hub, port } = await createBackend({
    onData: (sessionId, kind) => { if (sse) { sse.notify(sessionId, kind); } },
    onSessionEvent: (event, sessionId) => { if (sse) { sse.notify(sessionId, 'sessions'); } },
  });
  sse = createSseHub(backend);
  log(`whistle-vconsole v${VERSION} ${mode} mode (probe hub on ws port ${port})`);

  const panelHtml = buildPanelHtml();
  const lan = (getLanAddresses(port)[0] || {}).address || '127.0.0.1';
  const views = {
    panelHtml,
    injectHtml: buildInjectHtml({ lan, hubPort: port, httpPort: MCP_HTTP_PORT }),
  };
  log(`injected probe endpoint: http://${lan}:${MCP_HTTP_PORT}/probe.js`);

  const httpServer = http.createServer((req, res) => {
    handleRequest(backend, views, sse, req, res).catch((e) => {
      log(`request error: ${e && e.stack || e}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    });
  });

  try {
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(MCP_HTTP_PORT, '0.0.0.0', () => {
        httpServer.removeListener('error', reject);
        httpServer.on('error', (e) => log(`http server error: ${(e && e.message) || e}`));
        resolve();
      });
    });
  } catch (e) {
    try { hub.stop(); } catch (stopErr) { /* noop */ }
    throw e;
  }
  log(`panel + MCP endpoint: http://127.0.0.1:${MCP_HTTP_PORT}/ (MCP: /mcp)`);

  const runtime = {
    port: MCP_HTTP_PORT,
    hubPort: port,
    mode,
    ready: Promise.resolve(),
    stop() {
      try { hub.stop(); } catch (e) { /* noop */ }
      httpServer.close();
    },
  };
  return runtime;
}

async function handleRequest(backend, views, sse, req, res) {
  const url = (req.url || '/').split('?')[0];

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
      bundle = fs.readFileSync(PROBE_BUNDLE);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`探针产物缺失，请先构建：pnpm --filter @bobjoy/whistle.vconsole build (${PROBE_BUNDLE})`);
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

  // --- MCP Streamable HTTP (stateless) ------------------------------------
  if (url === '/mcp') {
    if (req.method !== 'POST') {
      // stateless mode has no SSE stream / session to terminate
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed (POST only in stateless mode)' }));
      return;
    }
    const raw = await readBody(req);
    // transport.handleRequest wants the *parsed* JSON-RPC body, not the raw Buffer
    let parsed;
    try {
      parsed = JSON.parse(raw.toString() || '{}');
    } catch (e) {
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
      try { transport.close(); } catch (e) { /* noop */ }
      try { server.close(); } catch (e) { /* noop */ }
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
    res.end(result.content[0].text);
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

/**
 * The markup whistle prepends to every proxied HTML page (see rules.txt).
 * Whistle fetches this on the dev machine and inlines it, so the page needs no
 * script of its own; the phone only has to reach the LAN probe bundle and hub.
 */
function buildInjectHtml(cfg) {
  const probeUrl = `http://${cfg.lan}:${cfg.httpPort}/probe.js`;
  const serverUrl = `ws://${cfg.lan}:${cfg.hubPort}`;
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

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
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

module.exports = { boot };
