/**
 * Core tool implementations, shared by both process modes:
 * - hub mode (owns the WebSocket port): executes directly
 * - proxy mode (port owned by another hub process): forwards over the WS api
 */

import type { ToolApiName } from './protocol.js';
import type { Hub, Session } from './hub.js';
import { fetchVueStateText, parseVueEvalResult, vueEvalExpr } from './vueTools.js';

export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export interface ToolCallOptions {
  /** target a specific session WITHOUT changing the hub's active session */
  sessionId?: string;
}

function resolveSession(hub: Hub, opts?: ToolCallOptions) {
  if (opts?.sessionId) {
    const session = hub.sessions.get(opts.sessionId);
    if (!session) {
      throw new Error(`session not found: ${opts.sessionId}`);
    }
    return session;
  }
  return hub.getActiveSession();
}

export function jsonResult(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(err: unknown): McpToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
  };
}

function num(v: unknown): number | undefined {
  return v === undefined || v === null ? undefined : Number(v);
}

function str(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}

/** Methods a replay can send without asking first. */
const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'OPTIONS'];

const REQUEST_NOT_FOUND = (requestId: string) =>
  `request not found: ${requestId} (buffers may have been evicted; re-list with get_network)`;

/**
 * Execute a tool call against the hub. Never throws: failures come back as
 * { isError } results so proxy mode can forward them verbatim.
 */
export async function handleTool(
  hub: Hub,
  name: ToolApiName,
  args: Record<string, unknown>,
  opts: ToolCallOptions = {},
): Promise<McpToolResult> {
  try {
    switch (name) {
      case 'list_sessions':
        return jsonResult({ sessions: hub.listSessions() });

      case 'select_session': {
        const session = hub.setActiveSession(String(args.sessionId));
        return jsonResult({ ok: true, active: session.summary() });
      }

      case 'get_logs': {
        const session = resolveSession(hub, opts);
        return jsonResult(session.getLogs({
          level: str(args.level),
          keyword: str(args.keyword),
          since: num(args.since),
          limit: num(args.limit),
        }));
      }

      case 'wait_for': {
        const session = resolveSession(hub, opts);
        const timeout = Math.min(num(args.timeoutMs) || 30000, 120000);
        if (args.kind === 'log') {
          const lower = str(args.contains)?.toLowerCase();
          const lvl = str(args.level);
          const item = await session.waitForLog((log) => {
            if (lvl && log.type !== lvl) { return false; }
            if (lower && !log.args.join(' ').toLowerCase().includes(lower)) { return false; }
            return true;
          }, timeout);
          return jsonResult({ kind: 'log', item });
        }
        const filter = str(args.urlFilter)?.toLowerCase();
        const item = await session.waitForNetwork((req) => {
          if (!filter) { return true; }
          const hay = `${req.method} ${req.url} ${req.status}`.toLowerCase();
          return hay.includes(filter);
        }, timeout);
        return jsonResult({ kind: 'network', item });
      }

      case 'get_network': {
        const session = resolveSession(hub, opts);
        if (args.requestId) {
          const item = session.getNetworkById(String(args.requestId));
          if (!item) {
            return errorResult(new Error(REQUEST_NOT_FOUND(String(args.requestId))));
          }
          return jsonResult(item);
        }
        return jsonResult(session.getNetwork({
          urlFilter: str(args.urlFilter),
          since: num(args.since),
          limit: num(args.limit),
          type: str(args.type),
        }));
      }

      case 'ws_frames': {
        const session = resolveSession(hub, opts);
        return jsonResult(session.getWsFrames({
          wsUrl: str(args.wsUrl),
          sinceFrameTime: num(args.sinceFrameTime),
          limit: num(args.limit),
        }));
      }

      case 'eval_js':
        return jsonResult(await hub.sendCommand('eval', { expression: String(args.expression) }, 30000, opts.sessionId));

      case 'get_dom':
        return jsonResult(await hub.sendCommand('get_dom', {
          selector: String(args.selector),
          limit: num(args.limit),
        }, 30000, opts.sessionId));

      case 'get_vue_tree': {
        // runs the panel's page-side vue serializer through the plain `eval`
        // command, so these tools work against every published probe
        const app = num(args.app);
        const treeExpr = vueEvalExpr(app === undefined ? 'apps' : 'tree', {
          app,
          path: str(args.path) || '',
          offset: num(args.offset),
          limit: num(args.limit),
        });
        const parsed = parseVueEvalResult(
          await hub.sendCommand('eval', { expression: treeExpr }, 30000, opts.sessionId),
        );
        if (parsed.error) {
          return errorResult(new Error(String(parsed.error)));
        }
        return jsonResult(parsed);
      }

      case 'get_vue_state': {
        const app = num(args.app);
        if (app === undefined) {
          return errorResult(new Error('需要 app 参数（先不带 app 调 get_vue_tree 列出应用）'));
        }
        const r = await fetchVueStateText(
          (expression) => hub.sendCommand('eval', { expression }, 30000, opts.sessionId),
          app,
          str(args.path) || '',
        );
        let state: unknown = r.text;
        try { state = JSON.parse(r.text); } catch { /* keep raw text */ }
        return jsonResult({
          app,
          path: str(args.path) || '',
          component: r.name,
          truncated: r.cut,
          state,
        });
      }

      case 'set_vue_state': {
        const app = num(args.app);
        const section = str(args.section);
        const key = str(args.key);
        if (app === undefined || !section || !key) {
          return errorResult(new Error('需要 app、section（data/setup/vuex/pinia）、key（点路径，pinia 首段为 store id）'));
        }
        const setExpr = vueEvalExpr('set', {
          app,
          path: str(args.path) || '',
          section,
          key,
          value: args.value,
        });
        const result = parseVueEvalResult(
          await hub.sendCommand('eval', { expression: setExpr }, 30000, opts.sessionId),
        );
        if (result.error) {
          return errorResult(new Error(String(result.error)));
        }
        return jsonResult(result);
      }

      case 'get_storage':
        return jsonResult(await hub.sendCommand('get_storage', {}, 30000, opts.sessionId));

      case 'set_storage':
        return jsonResult(await hub.sendCommand('set_storage', {
          storage: String(args.storage),
          key: String(args.key),
          value: args.value === undefined ? '' : String(args.value),
        }, 30000, opts.sessionId));

      case 'del_storage':
        return jsonResult(await hub.sendCommand('del_storage', {
          storage: String(args.storage),
          key: String(args.key),
        }, 30000, opts.sessionId));

      case 'get_page_info':
        return jsonResult(await hub.sendCommand('page_info', {}, 30000, opts.sessionId));

      case 'screenshot': {
        const shot = await hub.sendCommand('screenshot', {
          format: args.format === 'jpeg' ? 'jpeg' : 'png',
        }, 60000, opts.sessionId) as { format: string; width: number; height: number; dataBase64: string };
        return {
          content: [{
            type: 'image',
            data: shot.dataBase64,
            mimeType: shot.format === 'jpeg' ? 'image/jpeg' : 'image/png',
          }],
        };
      }

      case 'replay_request': {
        const session = resolveSession(hub, opts);
        const requestId = String(args.requestId);
        const source = session.getNetworkById(requestId);
        if (!source) {
          return errorResult(new Error(REQUEST_NOT_FOUND(requestId)));
        }
        if (source.requestType !== 'xhr' && source.requestType !== 'fetch') {
          return errorResult(new Error(
            `request ${requestId} is a ${source.requestType} request; only xhr and fetch requests can be replayed`,
          ));
        }
        const method = (source.method || 'GET').toUpperCase();
        if (!IDEMPOTENT_METHODS.includes(method) && args.allowUnsafe !== true) {
          return errorResult(new Error(
            `${method} is not idempotent, so replaying it repeats the side effect — nothing was sent. ` +
            `Pass allowUnsafe: true to replay it anyway.`,
          ));
        }
        // a lossy body (`[object Blob]` and friends) is refused page-side, where the real
        // captured shape still exists; the hub only holds display text, which can be truncated
        // the page sends it, so cookies and referer come along by themselves;
        // on timeout the request still runs to completion and is recorded —
        // read it back later with get_network
        return jsonResult(await hub.sendCommand('replay', { requestId }, 30000, opts.sessionId));
      }

      default:
        return errorResult(new Error(`unknown tool: ${name}`));
    }
  } catch (e) {
    return errorResult(e);
  }
}
