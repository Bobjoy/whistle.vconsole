/**
 * WebSocket hub: accepts probe connections, maintains
 * the session registry, routes streamed data into sessions and dispatches
 * commands to probes. The hub port is a plain http server, so the same origin
 * also serves the vendored browser assets (see staticAssets.ts).
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { serveVendoredAsset } from './staticAssets.js';
import type {
  HelloMsg, LogsMsg, NetworkMsg, ProbeMessage, CmdResultMsg, CmdType, ApiMsg,
} from './protocol.js';
import { MCP_PROXY_SESSION_ID, PROTOCOL_VERSION } from './protocol.js';
import { Session } from './session.js';
export { Session } from './session.js';
import { handleTool } from './tools.js';
import type { ToolApiName } from './protocol.js';

export interface HubConfig {
  host: string;
  port: number;
  /** required from non-loopback peers; loopback is the developer's own machine */
  token?: string;
  logBufferMax: number;
  networkBufferMax: number;
  sessionTtlMs: number;
  onSessionEvent?: (event: string, sessionId: string) => void;
  /** fired after new probe data was buffered (panel SSE feed) */
  onData?: (sessionId: string, kind: 'logs' | 'network') => void;
}

/**
 * A loopback peer is the developer's own machine: the MCP client on 127.0.0.1,
 * the panel reached through whistle, a sibling process attaching as a proxy.
 * They need no token. Everything arriving on a LAN interface does, because the
 * probe bundle and this protocol are published on npm — the address and the
 * message shape are public knowledge now, so bare reachability must not be
 * enough to attach a session or to drive one.
 */
export function isLoopback(addr?: string): boolean {
  return !addr || addr === '::1' || addr.startsWith('127.') || addr.toLowerCase() === '::ffff:127.0.0.1';
}

/** The single access rule both entry points share: loopback, or a matching `?t=`. */
export function hasAccess(rawUrl: string, remoteAddress: string | undefined, token?: string): boolean {
  if (isLoopback(remoteAddress)) { return true; }
  try {
    return new URL(rawUrl, 'http://localhost').searchParams.get('t') === token;
  } catch {
    return false;
  }
}

interface PendingCommand {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Hub {
  public config: HubConfig;
  public sessions = new Map<string, Session>();
  public activeSessionId: string | null = null;

  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private pending = new Map<string, PendingCommand>();
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  private stderr: (msg: string) => void;

  constructor(config: HubConfig, stderr: (msg: string) => void = () => {}) {
    this.config = config;
    this.stderr = stderr;
  }

  public async start(): Promise<void> {
    // our own http server on the hub port: ws upgrades ride it, and the same
    // origin answers the probe's plain GETs (vendored browser assets)
    const server = http.createServer((req, res) => {
      if (!serveVendoredAsset(req.url || '/', res)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
      }
    });
    this.httpServer = server;
    const wss = new WebSocketServer({ server });
    // ws mirrors listen errors onto the WebSocketServer instance, so both
    // objects need a listener from the first attempt: an unhandled 'error'
    // would kill the process before createBackend() can fall back to proxy mode
    const onError = (err: Error) => {
      this.stderr(`[ws] server error: ${err.message}`);
    };
    wss.on('error', onError);
    server.on('error', onError);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.port, this.config.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.wss = wss;
    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    this.purgeTimer = setInterval(() => this.purgeStaleSessions(), 60_000);
  }

  public stop() {
    if (this.purgeTimer) { clearInterval(this.purgeTimer); }
    for (const session of this.sessions.values()) {
      try { session.ws?.close(); } catch { /* noop */ }
    }
    this.wss?.close();
    this.httpServer?.close();
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!hasAccess(req.url || '/', req.socket.remoteAddress, this.config.token)) {
      // no session is created: a stranger on the LAN (or a web page that
      // guesses private addresses) cannot attach a probe or be listened to
      this.stderr(`[ws] refused connection from ${req.socket.remoteAddress}: bad or missing ?t= token`);
      ws.close(4001, 'bad token');
      return;
    }
    let session: Session | null = null;
    let sessionId = url.searchParams.get('sid');
    let isProxy = false;

    ws.on('message', (raw) => {
      let msg: ProbeMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') { return; }

      if (msg.type === 'hello') {
        if ((msg as HelloMsg).sessionId === MCP_PROXY_SESSION_ID) {
          // another MCP process sharing this hub; not a debug session
          isProxy = true;
          this.stderr(`[ws] MCP proxy attached from ${req.socket.remoteAddress}`);
          return;
        }
        sessionId = (msg as HelloMsg).sessionId || sessionId || 'unknown';
        session = this.ensureSession(sessionId);

        // same device (same fingerprint -> same session id): a NEWER page
        // connection supersedes the older one with a kick notice
        const existing = session.ws;
        if (existing && existing !== ws && existing.readyState === WebSocket.OPEN) {
          try { existing.send(JSON.stringify({ type: 'kick' })); } catch { /* noop */ }
          setTimeout(() => {
            try { existing.close(4000, 'superseded'); } catch { /* noop */ }
          }, 100);
          this.stderr(`[ws] session ${session.id} superseded by a newer connection from the same device`);
        }

        session.attach(ws, msg);
        if (!this.activeSessionId) {
          this.activeSessionId = session.id;
        }
        this.config.onSessionEvent?.('connected', session.id);
        this.stderr(`[ws] session ${session.id} connected: ${session.deviceLabel || ''} ${msg.page?.url || 'unknown url'}`.trim()
          + (session.protocolMismatch !== undefined
            ? ` (protocol mismatch: probe=${session.protocolMismatch} hub=${PROTOCOL_VERSION})` : ''));
        return;
      }

      if (isProxy) {
        if (msg.type === 'api') {
          this.handleProxyApi(ws, msg as ApiMsg);
        }
        return;
      }

      if (!session) { return; }
      session.lastSeenAt = Date.now();

      switch (msg.type) {
        case 'logs':
          session.addLogs((msg as LogsMsg).items || [], !!(msg as LogsMsg).reset);
          this.config.onData?.(session.id, 'logs');
          break;
        case 'network':
          session.addNetwork((msg as NetworkMsg).items || [], !!(msg as NetworkMsg).reset);
          this.config.onData?.(session.id, 'network');
          break;
        case 'result': {
          const r = msg as CmdResultMsg;
          const pending = this.pending.get(r.reqId);
          if (pending) {
            this.pending.delete(r.reqId);
            clearTimeout(pending.timer);
            if (r.ok) {
              pending.resolve(r.data);
            } else {
              pending.reject(new Error(r.error || 'probe command failed'));
            }
          }
          break;
        }
        case 'pong':
          break;
      }
    });

    ws.on('close', () => {
      if (isProxy) {
        this.stderr(`[ws] MCP proxy detached`);
        return;
      }
      if (session) {
        // only detach if THIS socket is still the attached one (a newer
        // same-device connection may already have superseded it)
        session.detach(ws);
        if (!session.online) {
          this.config.onSessionEvent?.('disconnected', session.id);
          this.stderr(`[ws] session ${session.id} disconnected`);
        }
      }
    });
  }

  /** Forward a proxy-mode MCP process' tool call to the local tool runtime. */
  private handleProxyApi(ws: WebSocket, msg: ApiMsg & { opts?: { sessionId?: string } }) {
    handleTool(this, msg.api as ToolApiName, msg.args || {}, msg.opts)
      .then((result) => {
        try {
          // always ok:true — the McpToolResult carries its own isError flag
          ws.send(JSON.stringify({ type: 'result', reqId: msg.reqId, ok: true, data: result }));
        } catch { /* proxy went away */ }
      });
  }

  /** Tool runtime entry (hub mode). */
  public handleTool(name: ToolApiName, args: Record<string, unknown>, opts?: { sessionId?: string }) {
    return handleTool(this, name, args, opts);
  }

  private ensureSession(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = new Session(id, this.config.logBufferMax, this.config.networkBufferMax);
      this.sessions.set(id, session);
    }
    return session;
  }

  private purgeStaleSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (!session.online && now - session.lastSeenAt > this.config.sessionTtlMs) {
        this.sessions.delete(id);
        if (this.activeSessionId === id) {
          this.activeSessionId = this.pickFallbackActiveSession();
        }
        this.stderr(`[ws] purged stale session ${id}`);
      }
    }
  }

  private pickFallbackActiveSession(): string | null {
    for (const [id, session] of this.sessions) {
      if (session.online) { return id; }
    }
    return this.sessions.keys().next().done ? null : (this.sessions.keys().next().value || null);
  }

  // -------------------------------------------------------------------------
  // session registry API (used by MCP tools)
  // -------------------------------------------------------------------------

  public listSessions() {
    // ordered by connection time (first connected first) so the list never
    // reshuffles while someone is clicking around in the panel
    return Array.from(this.sessions.values())
      .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
      .map((s) => ({ ...s.summary(), active: s.id === this.activeSessionId }));
  }

  public setActiveSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }
    this.activeSessionId = sessionId;
    return session;
  }

  public getActiveSession(): Session {
    if (!this.activeSessionId) {
      throw new Error('no probe session connected yet. Ask the user to open the H5 page with the probe enabled first.');
    }
    let session = this.sessions.get(this.activeSessionId);
    if (!session) {
      // fallback to any available session
      const first = this.sessions.values().next();
      if (first.done) {
        throw new Error('no probe session connected yet. Ask the user to open the H5 page with the probe enabled first.');
      }
      session = first.value;
      this.activeSessionId = session.id;
    }
    return session;
  }

  // -------------------------------------------------------------------------
  // command dispatch
  // -------------------------------------------------------------------------

  public sendCommand(cmd: CmdType, args: Record<string, unknown> = {}, timeoutMs = 30000, sessionId?: string): Promise<unknown> {
    const session = sessionId
      ? (this.sessions.get(sessionId) || (() => { throw new Error(`session not found: ${sessionId}`); })())
      : this.getActiveSession();
    if (!session.online || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`probe ${session.id} is offline (page may be closed); reconnect and retry`));
    }
    const reqId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`probe did not answer '${cmd}' within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      try {
        session.ws.send(JSON.stringify({ type: 'cmd', reqId, cmd, args }));
      } catch (e: any) {
        this.pending.delete(reqId);
        clearTimeout(timer);
        reject(new Error(`failed to send command to probe: ${e?.message || e}`));
      }
    });
  }
}
