#!/usr/bin/env node
/**
 * CLI entry: `whistle-vconsole [--port 9528] [--host 0.0.0.0]`
 *
 * Starts the WebSocket hub for probes and serves MCP over stdio.
 * All diagnostics go to stderr — stdout is the MCP protocol channel.
 */

import { startWithStdio, VERSION } from './index.js';

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args['help'] = '1';
    } else if (arg === '--version' || arg === '-v') {
      args['version'] = '1';
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
      args[key] = value;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args['help']) {
    console.error(`whistle-vconsole v${VERSION}

MCP server for AI agents to debug mobile H5 pages via a vConsole-based probe.

Usage:
  whistle-vconsole [--port 9528] [--host 0.0.0.0]

Options:
  --port    WebSocket port for probe connections (default 9528, env WHISTLE_VCONSOLE_PORT)
  --host    Bind address (default 0.0.0.0, env WHISTLE_VCONSOLE_HOST)

MCP transport: stdio. Diagnostics: stderr.`);
    process.exit(0);
  }
  if (args['version']) {
    console.error(`whistle-vconsole v${VERSION}`);
    process.exit(0);
  }

  await startWithStdio({
    port: args['port'] ? Number(args['port']) : undefined,
    host: args['host'],
  });
}

main().catch((err) => {
  console.error(`[whistle-vconsole] fatal: ${err?.stack || err}`);
  process.exit(1);
});
