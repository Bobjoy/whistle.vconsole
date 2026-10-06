/**
 * Proxy mode backend: when another MCP process already owns the WebSocket
 * port (ZCode spawns one MCP process per session), this process attaches to
 * that hub and forwards tool calls over the shared api protocol.
 */

import { WebSocket } from 'ws';
import type {
  ToolApiName, ApiMsg, CmdResultMsg,
} from '@bobjoy/vconsole-protocol';
import { MCP_PROXY_SESSION_ID, PROTOCOL_VERSION } from '@bobjoy/vconsole-protocol';
import type { McpToolResult } from './tools.js';

export interface ProxyHubOptions {
  port: number;
  /** must answer within this budget; the hub side may run 60s screenshots */
  apiTimeoutMs?: number;
  onStatus?: (status: 'connecting' | 'ready' | 'lost') => void;
}

interface PendingApi {
  resolve: (result: McpToolResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ProxyHub {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingApi>();
  private reqCounter = 0;
  private closedByUs = false;

  constructor(private opts: ProxyHubOptions) {}

  public async connect(): Promise<void> {
    const url = `ws://127.0.0.1:${this.opts.port}?sid=${MCP_PROXY_SESSION_ID}`;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;
      const fail = (err: Error) => {
        if (settled) { return; }
        settled = true;
        try { ws.close(); } catch { /* noop */ }
        reject(err);
      };
      ws.on('unexpected-response', (_req: any, res: any) => {
        fail(new Error(`port ${this.opts.port} is not a whistle-vconsole hub (status ${res.statusCode})`));
      });
      ws.on('error', (err: Error) => fail(new Error(`cannot reach hub on port ${this.opts.port}: ${err.message}`)));
      ws.on('close', () => {
        if (!settled) {
          fail(new Error(`connection closed by port ${this.opts.port}`));
          return;
        }
        this.onLost();
      });
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          sessionId: MCP_PROXY_SESSION_ID,
          probeVersion: 'mcp-proxy',
          page: {
            url: '', title: 'MCP proxy', referrer: '', userAgent: '', platform: '',
            language: '', viewport: { width: 0, height: 0, dpr: 1 }, screen: { width: 0, height: 0 },
            visibility: 'hidden', online: true,
          },
        }));
        this.ws = ws;
        this.opts.onStatus?.('ready');
        settled = true;
        resolve();
      });
      ws.on('message', (raw) => this.onMessage(String(raw)));
    });
  }

  private onLost() {
    if (this.closedByUs) { return; }
    this.ws = null;
    this.opts.onStatus?.('lost');
    const err = new Error('connection to hub lost');
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onMessage(raw: string) {
    let msg: CmdResultMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type !== 'result') { return; }
    const pending = this.pending.get(msg.reqId);
    if (!pending) { return; }
    this.pending.delete(msg.reqId);
    clearTimeout(pending.timer);
    // hub always answers ok:true with a full McpToolResult (isError inside)
    pending.resolve(
      msg.data && typeof msg.data === 'object' && 'content' in (msg.data as any)
        ? <McpToolResult>msg.data
        : { isError: true, content: [{ type: 'text', text: `Error: ${msg.error || 'hub call failed'}` }] },
    );
  }

  /** Tool runtime entry (proxy mode). */
  public async handleTool(name: ToolApiName, args: Record<string, unknown>, opts?: { sessionId?: string }): Promise<McpToolResult> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`hub on port ${this.opts.port} is not connected`);
    }
    const reqId = `api-${Date.now().toString(36)}-${++this.reqCounter}`;
    const msg: ApiMsg = {
      type: 'api',
      reqId,
      api: name,
      args: args || {},
      // sessionId targeting is honored hub-side; forward it in the api msg
      ...(opts?.sessionId ? { opts } : {}),
    };
    return new Promise<McpToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`hub did not answer '${name}' within ${this.opts.apiTimeoutMs || 120000}ms`));
      }, this.opts.apiTimeoutMs || 120000);
      this.pending.set(reqId, { resolve, reject, timer });
      try {
        this.ws!.send(JSON.stringify(msg));
      } catch (e: any) {
        this.pending.delete(reqId);
        clearTimeout(timer);
        reject(new Error(`failed to send to hub: ${e?.message || e}`));
      }
    });
  }

  public close() {
    this.closedByUs = true;
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
  }
}
