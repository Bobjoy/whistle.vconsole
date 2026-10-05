/**
 * Programmatic API: start the WS hub and the MCP server together.
 *
 * Port ownership: ZCode spawns one MCP process per session. The first
 * process binds the port and becomes the hub; every later process detects
 * the occupied port and attaches in proxy mode, forwarding tool calls to
 * the hub. All sessions therefore share the same probe connections.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HubConfig } from './hub.js';
import { Hub } from './hub.js';
import { ProxyHub } from './proxyHub.js';
import { createMcpServer } from './mcpServer.js';
import type { ToolBackend } from './mcpServer.js';

export { Hub } from './hub.js';
export { handleTool } from './tools.js';
export type { ToolCallOptions, McpToolResult } from './tools.js';
export { createMcpServer } from './mcpServer.js';
export type { ToolBackend } from './mcpServer.js';
export { parseDeviceLabel } from './deviceLabel.js';

export const VERSION = '0.3.0';

export interface StartOptions extends Partial<HubConfig> {
  /** log function for diagnostics; MUST NOT write to stdout (default: console.error) */
  log?: (msg: string) => void;
}

export function getLanAddresses(port: number): { address: string; iface: string }[] {
  const out: { address: string; iface: string }[] = [];
  const ifaces = os.networkInterfaces();
  for (const [iface, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        out.push({ address: addr.address, iface });
      }
    }
  }
  return out;
}

export function probeSnippet(serverUrl: string): string {
  return `import VConsole from '@bobjoy/vconsole';

new VConsole({
  serverUrl: '${serverUrl}',
  // deviceName: 'my-test-phone',  // optional label
  // hideUI: true,                 // hide the vConsole button (agent-only)
});`;
}

function isAddrInUse(e: unknown): boolean {
  const anyErr = e as any;
  return anyErr?.code === 'EADDRINUSE' || /EADDRINUSE/.test(String(anyErr?.message));
}

export interface StartedVconsoleMcp {
  backend: ToolBackend;
  mcpServer: McpServer;
  mode: 'hub' | 'proxy';
  hub?: Hub;
  proxy?: ProxyHub;
  port: number;
}

export interface CreatedBackend {
  backend: ToolBackend;
  mode: 'hub' | 'proxy';
  hub: Hub;
  proxy?: ProxyHub;
  port: number;
}

/**
 * Shared by the stdio server and the whistle plugin: try to own the probe
 * port (hub mode); when occupied, attach to the running hub as a proxy.
 * Self-heals on every tool call if the hub dies while this backend outlives it.
 */
export async function createBackend(opts: StartOptions = {}): Promise<CreatedBackend> {
  const log = opts.log || ((msg: string) => console.error(msg));
  const port = Number(opts.port ?? process.env.WHISTLE_VCONSOLE_PORT ?? 9528);
  const host = String(opts.host ?? process.env.WHISTLE_VCONSOLE_HOST ?? '0.0.0.0');

  const hub = new Hub({
    host,
    port,
    logBufferMax: opts.logBufferMax ?? 2000,
    networkBufferMax: opts.networkBufferMax ?? 500,
    sessionTtlMs: opts.sessionTtlMs ?? 30 * 60_000,
    onSessionEvent: opts.onSessionEvent,
    onData: opts.onData,
  }, log);

  let mode: 'hub' | 'proxy' = 'hub';
  let proxy: ProxyHub | undefined;

  try {
    await hub.start();
  } catch (e) {
    if (!isAddrInUse(e)) {
      throw e;
    }
    // --- port taken by (probably) another whistle-vconsole: attach as proxy --
    proxy = new ProxyHub({ port });
    await proxy.connect(); // throws when the occupier is not a whistle-vconsole hub
    mode = 'proxy';
  }

  if (mode === 'hub') {
    // discovery file: the whistle plugin (and other local tools) read this
    // to find the running hub without any manual configuration
    try {
      const dir = path.join(os.homedir(), '.whistle-vconsole');
      fs.mkdirSync(dir, { recursive: true });
      const lan = getLanAddresses(port)[0]?.address || '127.0.0.1';
      fs.writeFileSync(path.join(dir, 'hub.json'), JSON.stringify({
        port, lan, updatedAt: new Date().toISOString(),
      }, null, 2));
    } catch (e) {
      log(`  (could not write ~/.whistle-vconsole/hub.json: ${(e as Error).message})`);
    }
  }

  // self-healing backend: if the hub process dies while this proxy outlives
  // it, the next tool call retries taking over the port (or re-attaching)
  const backend: ToolBackend = mode === 'hub'
    ? hub
    : {
        async handleTool(name, args, opts) {
          try {
            return await proxy!.handleTool(name, args, opts);
          } catch (e) {
            // try to take over the port, then re-attach as proxy
            try {
              await hub.start();
              return await hub.handleTool(name, args, opts);
            } catch {
              try {
                proxy!.close();
                await proxy!.connect();
                return await proxy!.handleTool(name, args, opts);
              } catch {
                throw e;
              }
            }
          }
        },
      };

  return { backend, mode, hub, proxy, port };
}

export async function startVconsoleMcp(opts: StartOptions = {}): Promise<StartedVconsoleMcp> {
  const log = opts.log || ((msg: string) => console.error(msg));
  const { backend, mode, hub, proxy, port } = await createBackend(opts);
  const mcpServer = createMcpServer(backend, VERSION);

  // diagnostics go to stderr; stdout belongs to the MCP stdio protocol
  log(`whistle-vconsole v${VERSION} (${mode === 'hub' ? 'hub' : 'proxy'} mode)`);
  if (mode === 'hub') {
    log(`  ws hub listening on port ${port}`);
    for (const { address, iface } of getLanAddresses(port)) {
      log(`  probe endpoint: ws://${address}:${port}  (${iface})`);
    }
    log('  ---- probe init snippet (paste into your H5 entry, dev only) ----');
    const firstLan = getLanAddresses(port)[0]?.address || 'localhost';
    log(probeSnippet(`ws://${firstLan}:${port}`));
    log('  ----------------------------------------------------------------');
  } else {
    log(`  sharing existing vconsole hub on port ${port}; probe endpoint unchanged`);
  }

  return { backend, mcpServer, mode, hub, proxy, port };
}

export async function startWithStdio(opts: StartOptions = {}) {
  const { mcpServer, hub, proxy, mode } = await startVconsoleMcp(opts);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  const shutdown = () => {
    try { hub?.stop(); } catch { /* noop */ }
    try { proxy?.close(); } catch { /* noop */ }
  };
  process.on('exit', shutdown);
  return { hub, proxy, mode, mcpServer };
}
