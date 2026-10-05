/**
 * MCP tool surface. Tool descriptions are the agent's manual: keep them
 * precise about what each tool returns and when to use it.
 *
 * Execution lives in tools.ts (hub mode) or is forwarded to the hub
 * (proxy mode) — both expose the same `handleTool` entry.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolApiName } from '@bobjoy/vconsole-protocol';
import type { McpToolResult } from './tools.js';

export interface ToolBackend {
  handleTool(
    name: ToolApiName,
    args: Record<string, unknown>,
    opts?: { sessionId?: string },
  ): Promise<McpToolResult>;
}

export function createMcpServer(backend: ToolBackend, version: string): McpServer {
  const server = new McpServer({ name: 'whistle-vconsole', version });

  const tool = (
    name: ToolApiName,
    config: { title: string; description: string; inputSchema?: Record<string, any> },
  ) => {
    // every tool may target a specific session without changing the active one
    const inputSchema = {
      ...config.inputSchema,
      sessionId: z.string().optional().describe(
        'optional: target this sessionId instead of the active session (see list_sessions)',
      ),
    };
    server.registerTool(name, { ...config, inputSchema }, async (args: any): Promise<any> => {
      // sessionId stays in args (select_session uses it) AND is surfaced as
      // opts for the tools that target a session without switching the active one
      const opts = args?.sessionId
        ? { sessionId: String(args.sessionId) }
        : undefined;
      try {
        return await backend.handleTool(name, (args || {}) as Record<string, unknown>, opts);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: 'text' as const, text: `Error: ${message}` }] };
      }
    });
  };

  tool('list_sessions', {
    title: 'List connected H5 pages',
    description:
      'List all H5 pages (probe sessions) connected to this debug server, ordered by connection time (oldest first). ' +
      'Each entry has sessionId, url, title, userAgent, viewport, online status and buffer counts. ' +
      'The entry marked "active": true is the target of all other tools. ' +
      'Call this first if you are unsure which page is connected.',
  });

  tool('select_session', {
    title: 'Select the active H5 page',
    description:
      'Switch the target page that all other tools (get_logs, get_network, eval_js, ...) operate on. ' +
      'Use the sessionId from list_sessions. Needed when several phones/pages are connected at once.',
    inputSchema: { sessionId: z.string().describe('sessionId from list_sessions') },
  });

  tool('get_logs', {
    title: 'Get console logs from the page',
    description:
      'Fetch console logs captured on the active page (console.log/info/warn/error/debug, incl. uncaught errors routed by the app). ' +
      'Args: level (filter by one level), keyword (substring match on log text), since (cursor from a previous call; omit for latest), limit (default 100). ' +
      'Returns { items, nextSince } — pass nextSince as `since` next time to get only newer logs.',
    inputSchema: {
      level: z.enum(['log', 'info', 'warn', 'error', 'debug']).optional().describe('filter by log level'),
      keyword: z.string().optional().describe('substring filter on log text'),
      since: z.number().optional().describe('cursor from previous nextSince; omit for latest logs'),
      limit: z.number().optional().describe('max items to return (default 100)'),
    },
  });

  tool('wait_for', {
    title: 'Block until a matching log or request appears',
    description:
      'Wait (block) until a new console log or network request matching the filter arrives on the active page, then return it. ' +
      'kind: "log" (use `contains` and/or `level`) or "network" (use `urlFilter`, matches method+url+status). ' +
      'timeoutMs max 120000, default 30000. Use it after triggering an action (e.g. eval_js clicking a button) to observe the effect.',
    inputSchema: {
      kind: z.enum(['log', 'network']).describe('what to wait for'),
      contains: z.string().optional().describe('(log) substring to match against log text'),
      level: z.enum(['log', 'info', 'warn', 'error', 'debug']).optional().describe('(log) filter by level'),
      urlFilter: z.string().optional().describe('(network) substring against "method url status"'),
      timeoutMs: z.number().optional().describe('max wait in ms (default 30000, max 120000)'),
    },
  });

  tool('get_network', {
    title: 'Get captured network requests',
    description:
      'Fetch XHR/fetch/sendBeacon/resource/websocket requests captured on the active page. ' +
      'Args: urlFilter (substring against "method url status"), type (css/js/img/xhr/ws/other), since (cursor), limit (default 50), requestId (return ONE request with full detail instead of a list). ' +
      'List rows carry method, url, status, costTime, sizes and the bucketed type. Use requestId mode to read request/response bodies and headers of a single request.',
    inputSchema: {
      urlFilter: z.string().optional().describe('substring against "method url status"'),
      type: z.enum(['css', 'js', 'img', 'xhr', 'ws', 'other']).optional().describe('filter by request type bucket'),
      since: z.number().optional().describe('cursor from previous nextSince'),
      limit: z.number().optional().describe('max items to return (default 50)'),
      requestId: z.string().optional().describe('return one request with full detail (bodies/headers) instead of a list'),
    },
  });

  tool('ws_frames', {
    title: 'Stream WebSocket frames incrementally',
    description:
      'Pull WebSocket frames (send/receive) captured on the active page, with a time cursor so agents can poll for new frames without re-reading history. ' +
      'Args: wsUrl (filter to one connection), sinceFrameTime (cursor from a previous nextSince; omit for latest), limit (default 50). ' +
      'Returns { frames: [{ wsUrl, seq, type, data, time, totalBytes? }], nextSince, oldestSeq } — pass nextSince back as sinceFrameTime next time. ' +
      'Binary frames come back as base64 in `data` (decodes with atob / Buffer.from(b64,"base64")); the probe caps them at 8192 bytes and `totalBytes` then holds the original size. If oldestSeq is greater than the seq of your last-seen frame, some frames were evicted from the 2000-frame ring buffer.',
    inputSchema: {
      wsUrl: z.string().optional().describe('filter to a single WebSocket connection (exact url match)'),
      sinceFrameTime: z.number().optional().describe('cursor from a previous nextSince (epoch ms); omit for latest'),
      limit: z.number().optional().describe('max frames to return (default 50)'),
    },
  });

  tool('eval_js', {
    title: 'Evaluate JavaScript in the page',
    description:
      'Evaluate a JS expression in the global context of the active H5 page (like Chrome DevTools console / CDP Runtime.evaluate). ' +
      'Returns the serialized result. Use it to inspect state (window.x, localStorage), drive the UI (document.querySelector(...).click()), ' +
      'read components, or anything else. Side effects are real — this is the user\'s live page. ' +
      'The expression and its result also appear in the on-page vConsole panel for the human.',
    inputSchema: {
      expression: z.string().describe('JS expression to evaluate in the page, e.g. "location.href" or "document.querySelector(\'.btn\').click()"'),
    },
  });

  tool('get_dom', {
    title: 'Query DOM elements (outerHTML)',
    description:
      'Query the active page\'s DOM with a CSS selector and get matched elements\' outerHTML. ' +
      'Args: selector (CSS, e.g. "#app .item-list li"), limit (1-50, default 20). ' +
      'Each node: tag, id, classes, childElementCount, outerHTML (truncated at 5000 chars).',
    inputSchema: {
      selector: z.string().describe('CSS selector, e.g. "#app .item-list li"'),
      limit: z.number().optional().describe('max nodes to return (1-50, default 20)'),
    },
  });

  tool('get_storage', {
    title: 'Read cookies / localStorage / sessionStorage',
    description:
      'Read all cookies, localStorage and sessionStorage entries of the active page. ' +
      'Useful for auth token issues, feature flags, cached state.',
  });

  tool('set_storage', {
    title: 'Write a cookie / localStorage / sessionStorage entry',
    description:
      'Set one entry on the active page: storage is "local" | "session" | "cookie", plus key and value ' +
      '(an empty value clears it; a missing key creates it). ' +
      'The result reports the value the page actually holds after the write, so a refused cookie write (HttpOnly) or a quota failure is visible. ' +
      'Call get_storage first to see the current entries.',
    inputSchema: {
      storage: z.enum(['local', 'session', 'cookie']).describe('which store to write'),
      key: z.string().describe('entry name'),
      value: z.string().describe('new value'),
    },
  });

  tool('get_page_info', {
    title: 'Get page/environment info',
    description:
      'Get the active page\'s URL, title, user agent, viewport/DPR, screen size, online state, JS heap usage and navigation timing (TTFB, DOMContentLoaded, load). ' +
      'Call it first when you need to understand the environment or performance.',
  });

  tool('screenshot', {
    title: 'Screenshot the page (html2canvas)',
    description:
      'Capture a screenshot of the active page rendered via html2canvas (NOT a native capture: canvas/WebGL content and some CSS effects may be missing). ' +
      'Args: format "png" (default) or "jpeg". Returns an image. The first call may take a few seconds: ' +
      'the probe loads the vendored html2canvas from this server (public CDNs only as fallback).',
    inputSchema: {
      format: z.enum(['png', 'jpeg']).optional().describe('image format (default png)'),
    },
  });

  return server;
}
