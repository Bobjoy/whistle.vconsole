#!/usr/bin/env node
/**
 * CLI entry — `v2`.
 *
 *   v2                MCP server over stdio (for an MCP client's `command`)
 *   v2 start          standalone service as a background daemon
 *   v2 start -f       same service in the foreground
 *   v2 stop           stop that daemon (and only that daemon)
 *   v2 status         who, if anyone, is serving the shared HTTP port
 *
 * The standalone service owns the same two ports as the whistle plugin
 * (hub 9528, HTTP 9527) and the same HTTP surface (src/httpService.ts).
 * All diagnostics go to stderr — stdout belongs to the MCP stdio protocol,
 * except for the human-facing subcommands (`start`/`status`/`logs`).
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import type { HubConfig } from './hub.js';
import { createHttpService, MCP_HTTP_PORT } from './httpService.js';
import {
  getLanAddresses, hubFilePath, logFilePath, pidFilePath, startWithStdio, stateDir, VERSION,
} from './index.js';

// the panel template is plain CommonJS and stays outside the bundle (749 lines of
// hand-rolled HTML+JS), so it is required from the package at runtime
const req = createRequire(path.join(__dirname, 'cli.cjs'));

function loadPanelHtml(): string {
  return (req('../lib/panel.js') as () => string)();
}

interface CliArgs {
  [key: string]: string | undefined;
  help?: string;
  version?: string;
  f?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = '1';
    } else if (arg === '--version' || arg === '-v') {
      args.version = '1';
    } else if (arg === '-f' || arg === '--foreground') {
      args.f = '1';
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '1';
      args[key] = value;
    }
  }
  return args;
}

const HELP = `v2 v${VERSION} — whistle.vconsole standalone service + MCP server

Usage:
  v2                                 MCP server over stdio (hub on --port)
  v2 start [-f] [--port 9528] [--host 0.0.0.0] [--token <hex>]
                                     start the service; -f keeps it in the
                                     foreground (default: background daemon)
  v2 stop                            stop the daemon started by \`v2 start\`
  v2 status                          show what serves the debug port
  v2 logs [-f]                       the daemon log (last 200 lines; -f follows)

Options:
  --port    WebSocket port for probe connections (default 9528, env WHISTLE_VCONSOLE_PORT)
  --host    Bind address (default 0.0.0.0, env WHISTLE_VCONSOLE_HOST)
  --token   Token non-loopback peers must present (default: generated, printed on stderr; env WHISTLE_VCONSOLE_TOKEN)

The HTTP surface (panel + /mcp + /probe.js) is always port ${MCP_HTTP_PORT} — the same
port the whistle plugin serves, so the two forms are interchangeable.`;

function hubOptions(args: CliArgs): Partial<HubConfig> {
  return {
    port: args.port ? Number(args.port) : undefined,
    host: args.host,
    token: args.token,
  };
}

/** Whitelisted re-spawn flags — never forward arbitrary argv into the child. */
function forwardArgs(args: CliArgs): string[] {
  const out: string[] = [];
  if (args.port) { out.push('--port', String(args.port)); }
  if (args.host) { out.push('--host', String(args.host)); }
  if (args.token) { out.push('--token', String(args.token)); }
  return out;
}

const stderrLog = (msg: string) => console.error(`[whistle.vconsole] ${msg}`);

/** Foreground service: blocks until SIGINT/SIGTERM, then releases both ports. */
async function startForeground(args: CliArgs): Promise<void> {
  const service = await createHttpService({
    ...hubOptions(args), panelHtml: loadPanelHtml(), log: stderrLog,
  });

  for (const { address, iface } of getLanAddresses(service.hubPort)) {
    stderrLog(`  probe endpoint: ws://${address}:${service.hubPort}?t=${service.token}  (${iface})`);
  }
  stderrLog(`  standalone 没有自动注入（那是 whistle 插件的规则），页面需自己引探针：外链 http://<局域网IP>:${MCP_HTTP_PORT}/probe.js 或 npm/CDN 包；https 页面只能连 wss://，前面自己架 TLS 隧道（docs/adr/0002）`);

  await new Promise<void>((resolve) => {
    const done = () => {
      try { service.stop(); } catch { /* noop */ }
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

function readPidFile(): number | null {
  try {
    const pid = Number(fs.readFileSync(pidFilePath(), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when :9527 answers like our own panel does (hub or plugin, same face). */
function servingHttpPort(timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = http.get(
      { host: '127.0.0.1', port: MCP_HTTP_PORT, path: '/api/sessions', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(res.statusCode === 200 && body.includes('"sessions"')));
      },
    );
    probe.on('error', () => resolve(false));
    probe.on('timeout', () => { probe.destroy(); resolve(false); });
  });
}

function tailLog(bytes = 4000): string {
  try {
    const buf = fs.readFileSync(logFilePath());
    return buf.subarray(Math.max(0, buf.length - bytes)).toString();
  } catch {
    return '(没有日志文件)';
  }
}

/** `v2 start` without -f: spawn a detached daemon and only report once it answers. */
async function startDaemon(args: CliArgs): Promise<void> {
  const existing = readPidFile();
  if (existing && isAlive(existing)) {
    if (await servingHttpPort()) {
      console.log(`v2 daemon 已在运行 (pid ${existing})，面板: http://127.0.0.1:${MCP_HTTP_PORT}/`);
    } else {
      // alive but not answering yet (still booting, or wedged): starting a second
      // one would only collide with it
      console.log(`v2 daemon 已在运行 (pid ${existing})，但 :${MCP_HTTP_PORT} 还没应答——看 v2 logs`);
    }
    return;
  }
  if (existing) {
    fs.rmSync(pidFilePath(), { force: true }); // a dead pid is stale, not a running daemon
  }
  if (await servingHttpPort()) {
    console.error(`:${MCP_HTTP_PORT} 已由 whistle 插件在服务，直接用 http://127.0.0.1:${MCP_HTTP_PORT}/ 就够了（standalone 无需再起）`);
    process.exit(1);
  }

  fs.mkdirSync(stateDir(), { recursive: true });
  const fd = fs.openSync(logFilePath(), 'a');
  const child: ChildProcess = spawn(process.execPath, [__filename, 'start', '-f', ...forwardArgs(args)], {
    detached: true,
    stdio: ['ignore', fd, fd],
    cwd: process.cwd(),
  });
  fs.closeSync(fd);
  const pid = child.pid as number;
  let died = false;
  child.on('exit', () => { died = true; });
  child.unref();
  fs.writeFileSync(pidFilePath(), `${pid}\n`);

  // readiness comes from the socket, not from a sleep: the daemon is only
  // "started" once its own panel API answers
  const deadline = Date.now() + 3000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    if (died) { break; }
    ready = await servingHttpPort(600);
    if (!ready) { await new Promise((r) => setTimeout(r, 100)); }
  }

  if (!ready) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    fs.rmSync(pidFilePath(), { force: true });
    console.error(`v2 daemon 启动失败（:${MCP_HTTP_PORT} 没有应答）。日志尾部：\n${tailLog()}`);
    process.exit(1);
  }

  console.log(`v2 daemon 已启动 (pid ${pid})`);
  console.log(`  面板: http://127.0.0.1:${MCP_HTTP_PORT}/  (MCP: http://127.0.0.1:${MCP_HTTP_PORT}/mcp)`);
  console.log('  日志: v2 logs');
}

/**
 * `v2 stop`: only the pid this CLI recorded is ever signalled. A port answered
 * by someone else (the whistle plugin) is reported, never touched — there is no
 * by-port process lookup anywhere in here.
 */
async function stopDaemon(): Promise<void> {
  const pid = readPidFile();
  const serving = await servingHttpPort();

  if (!pid || !isAlive(pid)) {
    if (pid) { fs.rmSync(pidFilePath(), { force: true }); }
    if (serving) {
      console.error(`:${MCP_HTTP_PORT} 有人应答，但 v2.pid 里没有活的进程——这个端口不是 v2 daemon 在服务（可能是 whistle 插件），不会去动它`);
      process.exit(1);
    }
    console.log('没有 v2 daemon 在跑');
    return;
  }

  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  const deadline = Date.now() + 3000;
  let released = false;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) { released = true; break; }
    if (!(await servingHttpPort(500))) { released = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!released) {
    // no SIGKILL: a half-closed hub would make the next start collide harder
    try { process.kill(pid, 'SIGTERM'); } catch { /* noop */ }
    console.error(`v2 daemon (pid ${pid}) 收到 SIGTERM 但 :${MCP_HTTP_PORT} 仍未释放，没有强杀——看 v2 logs 找原因`);
    process.exit(1);
  }
  fs.rmSync(pidFilePath(), { force: true });
  console.log(`v2 daemon 已停止 (pid ${pid})`);
}

/**
 * The other half of "one package, two install paths": `w2 install` and
 * `npm i -g` each carry their own copy, so say out loud when they disagree.
 */
function pluginVersion(): string | null {
  const pkgPath = path.join(os.homedir(), '.WhistleAppData', 'custom_plugins', '@bobjoy',
    'whistle.vconsole', 'node_modules', '@bobjoy', 'whistle.vconsole', 'package.json');
  try {
    return String(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version);
  } catch {
    return null;
  }
}

/** `v2 status`: who owns the shared HTTP port — and never the token. */
async function statusCommand(): Promise<void> {
  const pid = readPidFile();
  const alive = pid !== null && isAlive(pid);
  const serving = await servingHttpPort();
  const lines: string[] = [];

  if (!serving) {
    lines.push(`stopped   :${MCP_HTTP_PORT} 上没有服务（v2 start 起一个，或用 whistle 插件）`);
  } else {
    lines.push(alive
      ? `daemon    pid ${pid} 在跑`
      : 'in-plugin 有人在服务，但 v2.pid 里没有活的进程 — 那是 whistle 插件，不需要 standalone');
    lines.push(`  面板: http://127.0.0.1:${MCP_HTTP_PORT}/`);
    lines.push(`  MCP:  http://127.0.0.1:${MCP_HTTP_PORT}/mcp`);
    try {
      const hub = JSON.parse(fs.readFileSync(hubFilePath(), 'utf8'));
      lines.push(`  探针: ws://${hub.lan}:${hub.port}（token 见 v2 logs 或插件启动日志）`);
    } catch {
      lines.push('  探针: 没有 hub.json，起服务后会生成');
    }
  }

  // the drift warning is about the install, not about the running service
  const installed = pluginVersion();
  if (installed && installed !== VERSION) {
    lines.push(`  版本漂移: 当前命令 v${VERSION} ≠ 插件目录 v${installed}（~/.WhistleAppData/custom_plugins）——两条安装路只留一条`);
  }

  for (const line of lines) {
    console.log(line);
  }
}

/** `v2 logs`: read the daemon's own log file; -f follows without touching it. */
function logsCommand(args: CliArgs): void {
  const p = logFilePath();
  if (!fs.existsSync(p)) {
    console.log(`还没有 daemon 日志（${p}）——先 v2 start`);
    if (!args.f) { return; }
    const waiter = setInterval(() => {
      if (fs.existsSync(p)) { clearInterval(waiter); followLog(p); }
    }, 500);
    process.once('SIGINT', () => { clearInterval(waiter); process.exit(0); });
    return;
  }
  if (!args.f) {
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.length);
    console.log(lines.slice(-200).join('\n'));
    return;
  }
  followLog(p);
}

function followLog(p: string): void {
  let size = fs.statSync(p).size;
  const poll = setInterval(() => {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.size === size) { return; }
    if (st.size < size) { size = 0; } // truncated
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(st.size - size);
    fs.readSync(fd, buf, 0, buf.length, size);
    fs.closeSync(fd);
    size = st.size;
    process.stdout.write(buf.toString());
  }, 300);
  // Ctrl-C ends the tail only — the daemon is a separate process
  process.once('SIGINT', () => { clearInterval(poll); process.exit(0); });
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : '';
  const args = parseArgs(command ? argv.slice(1) : argv);

  if (args.help) {
    console.error(HELP);
    process.exit(0);
  }
  if (args.version) {
    console.error(`v2 v${VERSION}`);
    process.exit(0);
  }

  switch (command) {
    case '':
      // bare run: MCP over stdio, unchanged since before the standalone form
      await startWithStdio(hubOptions(args));
      return;
    case 'start':
      if (args.f) {
        await startForeground(args);
      } else {
        await startDaemon(args);
      }
      return;
    case 'stop':
      await stopDaemon();
      return;
    case 'status':
      await statusCommand();
      return;
    case 'logs':
      logsCommand(args);
      return;
    default:
      console.error(`${HELP}\n\nunknown command: ${command}`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`[whistle.vconsole] fatal: ${err?.stack || err}`);
  process.exit(1);
});
