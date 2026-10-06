/**
 * CLI e2e — the `v2` process boundary: exit codes, pid/log files and what
 * :9527 / the hub port actually answer. This is the seam the standalone spec
 * was written against, so every case here is a user story.
 *
 * The HTTP port is fixed at 9527 (no --http-port by design, ADR-005), so these
 * cases run SERIALLY and refuse to start when something else already owns 9527.
 * Every case passes HOME= tmpdir so ~/.whistle-vconsole/{hub.json,v2.pid,v2.log}
 * never touches the real home, and an explicit --token so the hub is deterministic.
 *
 * Run: node packages/whistle-plugin/test/cli.e2e.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(here, '..');
const CLI = path.join(PKG, 'dist', 'cli.cjs');
const HTTP_PORT = 9527;
const HUB_PORT = 9351;
const TOKEN = 'cli32e0token';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name} ${detail}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wv-cli-'));
}

function getJson(port, p = '/api/sessions') {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 1200 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ error: e.code || String(e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

/** Spawn the CLI with an isolated HOME; returns the child plus captured streams. */
function spawnCli(args, home, opts = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: PKG,
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  const out = { child, stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c.toString(); });
  child.stderr.on('data', (c) => { out.stderr += c.toString(); });
  return out;
}

async function waitServing(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await getJson(port);
    if (r.status === 200 && r.body.includes('"sessions"')) { return r; }
    await sleep(120);
  }
  return null;
}

async function waitDown(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await getJson(port);
    if (r.error) { return true; }
    await sleep(120);
  }
  return false;
}

function hubFile(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.whistle-vconsole', 'hub.json'), 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitExit(child, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(t);
      resolve(signal ? `signal:${signal}` : code);
    });
  });
}

/** A stop that only released the sockets leaves a ghost process behind. */
async function waitPidDown(pid, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) { return true; }
    await sleep(150);
  }
  return !isAlive(pid);
}

/** Test-side stop: the daemon path is exercised before `v2 stop` exists. */
function stopDaemon(home) {
  const pidPath = path.join(home, '.whistle-vconsole', 'v2.pid');
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) { process.kill(pid, 'SIGTERM'); }
    fs.rmSync(pidPath, { force: true });
  } catch { /* nothing to stop */ }
}

/** A probe that answers nothing — hello is enough to show up in list_sessions. */
function fakeProbe(sessionId, hubPort = HUB_PORT) {
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}?sid=${sessionId}&t=${TOKEN}`);
  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello', protocol: 1, sessionId, deviceName: sessionId, probeVersion: 'cli-e2e',
        page: {
          url: `https://example.com/${sessionId}`, title: sessionId, referrer: '',
          userAgent: 'cli-e2e', platform: 'test', language: 'zh',
          viewport: { width: 390, height: 844, dpr: 3 }, screen: { width: 390, height: 844 },
          visibility: 'visible', online: true,
        },
      }));
      resolve();
    });
    ws.on('error', reject);
  });
  return { ws, ready };
}

async function killTree(child) {
  if (child.exitCode !== null || child.signalCode) { return; }
  child.kill('SIGKILL');
  await sleep(200);
}

// --- story 1 + 5: `v2 start -f` serves both ports, stdout stays clean ------
async function caseStartForeground() {
  const home = makeHome();
  const cli = spawnCli(['start', '-f', '--port', String(HUB_PORT), '--host', '127.0.0.1', '--token', TOKEN], home);
  const served = await waitServing(HTTP_PORT);
  check('start -f: :9527 answers like our own panel', served !== null, JSON.stringify(served));

  const probe = fakeProbe('fg-1');
  await probe.ready;
  await sleep(300);
  const r = await getJson(HTTP_PORT);
  check('start -f: a probe connects to the standalone hub and shows in the panel API',
    r.status === 200 && r.body.includes('fg-1'), r.body);

  check('start -f: stderr prints the panel + MCP url',
    /panel \+ MCP endpoint: http:\/\/127\.0\.0\.1:9527\/ \(MCP: \/mcp\)/.test(cli.stderr), cli.stderr.slice(-400));
  check('start -f: stderr prints the LAN probe endpoint with the token',
    cli.stderr.includes(`?t=${TOKEN}`) && /probe endpoint: ws:\/\//.test(cli.stderr), cli.stderr.slice(-400));
  check('start -f: stderr says standalone does not inject',
    /没有自动注入/.test(cli.stderr), cli.stderr.slice(-400));
  check('start -f: stderr never prints a pasteable snippet',
    !cli.stderr.includes('<script') && !cli.stderr.includes('import VConsole'), cli.stderr.slice(-400));
  check('start -f: stdout is reserved (nothing written)', cli.stdout === '', JSON.stringify(cli.stdout));

  const stored = hubFile(home);
  check('start -f: hub.json carries the --port value (story 5)', stored && Number(stored.port) === HUB_PORT, JSON.stringify(stored));
  check('start -f: hub.json carries the --token value (story 5)', stored && stored.token === TOKEN, JSON.stringify(stored));

  cli.child.kill('SIGINT');
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    cli.child.on('exit', () => { clearTimeout(t); resolve(true); });
  });
  check('start -f: SIGINT exits the process', exited);
  check('start -f: after SIGINT :9527 refuses', await waitDown(HTTP_PORT));
  check('start -f: after SIGINT the hub port refuses', await waitDown(HUB_PORT));

  await probe.ws.close();
  await killTree(cli.child);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- story 2/4: `v2 start` detaches, is idempotent, and reports readiness --
async function caseStartBackground() {
  const home = makeHome();
  const hubPort = 9352;
  const run = () => spawnCli(['start', '--port', String(hubPort), '--host', '127.0.0.1', '--token', TOKEN], home);

  const first = run();
  const code = await waitExit(first.child, 10000);
  check('start: the parent exits 0 (story 2)', code === 0, `code=${code} err=${first.stderr.slice(-300)}`);
  const served = await waitServing(HTTP_PORT, 4000);
  check('start: the daemon keeps serving after the parent returns (story 2)',
    served !== null && served.body.includes('"sessions"'), JSON.stringify(served));
  check('start: stdout reports the panel url and points at `v2 logs` (story 2)',
    /http:\/\/127\.0\.0\.1:9527\/ /.test(first.stdout) && /v2 logs/.test(first.stdout), JSON.stringify(first.stdout));
  check('start: stdout does not leak the token', !first.stdout.includes(TOKEN), JSON.stringify(first.stdout));

  const pidPath = path.join(home, '.whistle-vconsole', 'v2.pid');
  const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
  check('start: v2.pid holds a live pid (story 2)', Number.isInteger(pid) && pid > 0 && isAlive(pid), String(pid));
  const stored = hubFile(home);
  check('start: the daemon wrote hub.json with its hub port', stored && Number(stored.port) === hubPort, JSON.stringify(stored));

  const second = run();
  const code2 = await waitExit(second.child, 10000);
  const pidAfter = Number(fs.readFileSync(pidPath, 'utf8').trim());
  check('start: a second `start` exits 0 (story 4)', code2 === 0, `code=${code2} out=${second.stdout}`);
  check('start: a second `start` reuses the running daemon, no new pid (story 4)', pidAfter === pid, `${pid} -> ${pidAfter}`);
  check('start: a second `start` says it is already running (story 4)',
    /已在运行|already running/.test(second.stdout + second.stderr), JSON.stringify(second.stdout));
  // one daemon only: count the `start -f` processes on this machine (darwin/linux)
  const ps = execSync(`ps -Ao args= | grep -F "cli.cjs" | grep -F "start" | grep -F "-f" | grep -v grep || true`, { encoding: 'utf8' });
  const daemons = ps.split('\n').filter((l) => l.includes('cli.cjs')).length;
  check('start: exactly one daemon process (story 4)', daemons <= 1, `${daemons}: ${ps.trim()}`);

  stopDaemon(home);
  check('start: teardown released :9527', await waitDown(HTTP_PORT));
  fs.rmSync(home, { recursive: true, force: true });
}

// --- story 3: readiness is proven by the socket, not by a sleep ------------
async function caseStartFailsWhenTheHubPortIsStuck() {
  const home = makeHome();
  const blocker = net.createServer((sock) => { sock.destroy(); });
  await new Promise((r) => blocker.listen(9353, '127.0.0.1', r));

  const cli = spawnCli(['start', '--port', '9353', '--host', '127.0.0.1', '--token', TOKEN], home);
  const code = await waitExit(cli.child, 20000);
  check('start: fails (non-zero) when the service never becomes ready (story 3)', code !== 0, `code=${code}`);
  check('start: the failure pastes the log tail into stderr (story 3)',
    /hub\.json|EADDRINUSE|proxy|failed|error/i.test(cli.stderr), cli.stderr.slice(-400));
  const pidPath = path.join(home, '.whistle-vconsole', 'v2.pid');
  const left = fs.existsSync(pidPath) ? Number(fs.readFileSync(pidPath, 'utf8').trim()) : null;
  check('start: no stale pid is left behind (story 3)', left === null || !isAlive(left), String(left));
  check('start: nothing ends up serving :9527 after the failure', (await getJson(HTTP_PORT)).error !== undefined);

  blocker.close();
  fs.rmSync(home, { recursive: true, force: true });
}

// --- story 11: the whistle plugin already owns 9527 -> point at the plugin --
async function caseStartRefusesWhenPluginOwnsHttpPort() {
  const home = makeHome();
  // a stand-in for the plugin's HTTP surface: answers /api/sessions like our panel
  const fake = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/api/sessions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => fake.listen(HTTP_PORT, '0.0.0.0', r));

  const cli = spawnCli(['start', '--port', '9354', '--host', '127.0.0.1', '--token', TOKEN], home);
  const code = await waitExit(cli.child, 15000);
  check('start: refuses to start when something else serves 9527 (story 11)', code !== 0, `code=${code}`);
  check('start: the refusal names the whistle plugin and its url (story 11)',
    /插件/.test(cli.stderr) && cli.stderr.includes(`http://127.0.0.1:${HTTP_PORT}/`), cli.stderr.slice(-400));
  check('start: no pid file when it refused (story 11)',
    !fs.existsSync(path.join(home, '.whistle-vconsole', 'v2.pid')));

  fake.close();
  await waitDown(HTTP_PORT);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- story 6 + 7: `v2 stop` only ever touches the pid it recorded ----------
async function caseStop() {
  const home = makeHome();
  const up = spawnCli(['start', '--port', '9355', '--host', '127.0.0.1', '--token', TOKEN], home);
  const upCode = await waitExit(up.child, 10000);
  check('stop: precondition — daemon is up',
    upCode === 0 && (await getJson(HTTP_PORT)).body?.includes('"sessions"') === true, `code=${upCode}`);
  const pid = Number(fs.readFileSync(path.join(home, '.whistle-vconsole', 'v2.pid'), 'utf8').trim());

  // a panel left open is an SSE client that never closes on its own; `stop` must
  // not leave the daemon breathing on that socket
  let sseClosed = false;
  const sse = http.get({ host: '127.0.0.1', port: HTTP_PORT, path: '/api/events' }, () => {});
  sse.on('close', () => { sseClosed = true; });
  sse.on('error', () => {});
  await sleep(300);

  const stop = spawnCli(['stop'], home);
  const code = await waitExit(stop.child, 10000);
  check('stop: exits 0 (story 6)', code === 0, `code=${code} err=${stop.stderr.slice(-300)}`);
  check('stop: releases :9527 (story 6)', await waitDown(HTTP_PORT));
  check('stop: the hub port is gone too (story 6)', await waitDown(9355));
  check('stop: the pid file is removed (story 6)',
    !fs.existsSync(path.join(home, '.whistle-vconsole', 'v2.pid')));
  check('stop: the recorded pid is dead (story 6)', await waitPidDown(pid));
  await sleep(200);
  check('stop: the open SSE client is dropped, not kept as a ghost process (story 6)', sseClosed);
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } // never leak a daemon into the next case
  sse.destroy();

  // stopping twice must not go hunting for something to kill
  const again = spawnCli(['stop'], home);
  const againCode = await waitExit(again.child, 8000);
  check('stop: a second `stop` finds nothing and exits 0',
    againCode === 0 && /没有 v2 daemon|not running|nothing/i.test(again.stdout + again.stderr),
    `code=${againCode} out=${JSON.stringify(again.stdout)} err=${again.stderr.slice(-200)}`);

  fs.rmSync(home, { recursive: true, force: true });
}

async function caseStopNeverTouchesSomeoneElsesPort() {
  const home = makeHome();
  // stand-in for the whistle plugin: it owns :9527 inside THIS process, so if
  // `stop` went looking for whoever holds the port it would kill the suite itself
  const fake = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/api/sessions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => fake.listen(HTTP_PORT, '0.0.0.0', r));

  const stop = spawnCli(['stop'], home);
  const code = await waitExit(stop.child, 8000);
  check('stop: refuses to stop a port it does not own (story 7)', code !== 0, `code=${code}`);
  check('stop: says the port is not served by a v2 daemon (story 7)',
    /不是 v2 daemon 在服务/.test(stop.stderr) && /whistle 插件/.test(stop.stderr), stop.stderr.slice(-300));
  check('stop: the other owner is untouched and still answering (story 7)',
    (await getJson(HTTP_PORT)).body?.includes('"sessions"') === true);

  fake.close();
  await waitDown(HTTP_PORT);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- story 8 + 9: `v2 status` says who owns 9527, without leaking the token --
async function caseStatusThreeStates() {
  const home = makeHome();

  const stopped = spawnCli(['status'], home);
  const c1 = await waitExit(stopped.child, 8000);
  check('status: stopped when nothing runs (story 8)',
    c1 === 0 && /stopped/.test(stopped.stdout) && !/daemon|in-plugin/.test(stopped.stdout),
    `code=${c1} out=${JSON.stringify(stopped.stdout)}`);

  const up = spawnCli(['start', '--port', '9356', '--host', '127.0.0.1', '--token', TOKEN], home);
  check('status: precondition — daemon is up', (await waitExit(up.child, 10000)) === 0, up.stderr.slice(-300));

  const daemon = spawnCli(['status'], home);
  const c2 = await waitExit(daemon.child, 8000);
  const pid = Number(fs.readFileSync(path.join(home, '.whistle-vconsole', 'v2.pid'), 'utf8').trim());
  check('status: daemon reports pid + panel + probe endpoint (story 8)',
    c2 === 0 && /daemon/.test(daemon.stdout) && daemon.stdout.includes(String(pid))
      && daemon.stdout.includes(`http://127.0.0.1:${HTTP_PORT}/`)
      && /ws:\/\/[\d.]+:9356/.test(daemon.stdout),
    `code=${c2} out=${daemon.stdout}`);
  check('status: daemon mode still tells you where the token is (story 8)',
    /v2 logs/.test(daemon.stdout), daemon.stdout);
  check('status: never echoes the token (story 8)', !daemon.stdout.includes(TOKEN), JSON.stringify(daemon.stdout));

  stopDaemon(home);
  await waitDown(HTTP_PORT);

  // someone else owns the port and v2.pid is gone: that is the plugin's shape
  const fake = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/api/sessions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => fake.listen(HTTP_PORT, '0.0.0.0', r));
  const plugin = spawnCli(['status'], home);
  const c3 = await waitExit(plugin.child, 8000);
  check('status: in-plugin when the port answers but no daemon pid does (story 8)',
    c3 === 0 && /in-plugin/.test(plugin.stdout) && /插件/.test(plugin.stdout),
    `code=${c3} out=${plugin.stdout}`);
  check('status: in-plugin still does not echo a token (story 8)', !plugin.stdout.includes(TOKEN), plugin.stdout);
  fake.close();
  await waitDown(HTTP_PORT);
  fs.rmSync(home, { recursive: true, force: true });
}

// story 9: the same code can be installed twice (w2 install + npm i -g)
async function caseStatusVersionDrift() {
  const home = makeHome();
  const pluginPkgDir = path.join(home, '.WhistleAppData', 'custom_plugins', '@bobjoy', 'whistle.vconsole',
    'node_modules', '@bobjoy', 'whistle.vconsole');
  fs.mkdirSync(pluginPkgDir, { recursive: true });
  const pkgPath = path.join(pluginPkgDir, 'package.json');

  fs.writeFileSync(pkgPath, JSON.stringify({ name: '@bobjoy/whistle.vconsole', version: '0.0.1' }));
  const drift = spawnCli(['status'], home);
  await waitExit(drift.child, 8000);
  check('status: flags a version drift between the two installs (story 9)',
    /版本漂移|drift/i.test(drift.stdout) && drift.stdout.includes('0.0.1'), JSON.stringify(drift.stdout));

  const ours = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
  fs.writeFileSync(pkgPath, JSON.stringify({ name: '@bobjoy/whistle.vconsole', version: ours }));
  const same = spawnCli(['status'], home);
  await waitExit(same.child, 8000);
  check('status: silent when both installs are the same version (story 9)',
    !/版本漂移|drift/i.test(same.stdout), JSON.stringify(same.stdout));

  // no plugin install at all is the normal standalone case — must not be an error
  fs.rmSync(path.join(home, '.WhistleAppData'), { recursive: true, force: true });
  const bare = spawnCli(['status'], home);
  const code = await waitExit(bare.child, 8000);
  check('status: a machine without the whistle plugin exits 0 (story 9)',
    code === 0 && !/版本漂移|drift|Error/.test(bare.stdout + bare.stderr), `code=${code}`);

  fs.rmSync(home, { recursive: true, force: true });
}

// --- story 10: `v2 logs` reads what the daemon wrote, -f follows it ---------
async function caseLogs() {
  const home = makeHome();

  const empty = spawnCli(['logs'], home);
  const emptyCode = await waitExit(empty.child, 8000);
  check('logs: no log file yet is not an error (story 10)',
    emptyCode === 0 && /还没有/.test(empty.stdout), `code=${emptyCode} out=${JSON.stringify(empty.stdout)}`);

  const up = spawnCli(['start', '--port', '9357', '--host', '127.0.0.1', '--token', TOKEN], home);
  check('logs: precondition — daemon is up', (await waitExit(up.child, 10000)) === 0, up.stderr.slice(-300));

  const probe = fakeProbe('logs-1', 9357);
  await probe.ready;
  await sleep(400);

  const shown = spawnCli(['logs'], home);
  const shownCode = await waitExit(shown.child, 8000);
  check('logs: the daemon log holds the startup diagnostics (story 10)',
    shownCode === 0 && /panel \+ MCP endpoint/.test(shown.stdout), `code=${shownCode}`);
  check('logs: a probe attaching shows up in `v2 logs` (story 10)',
    shown.stdout.includes('logs-1'), shown.stdout.slice(-300));

  // the tail is capped at 200 lines, in file order
  const logPath = path.join(home, '.whistle-vconsole', 'v2.log');
  fs.appendFileSync(logPath, Array.from({ length: 300 }, (_, i) => `filler-${i}`).join('\n') + '\n');
  const tail = spawnCli(['logs'], home);
  await waitExit(tail.child, 8000);
  const tailLines = tail.stdout.split('\n').filter((l) => l.length);
  check('logs: default tail is 200 lines (story 10)', tailLines.length === 200, String(tailLines.length));
  check('logs: the tail is the END of the file (story 10)',
    tailLines[tailLines.length - 1] === 'filler-299' && !tailLines.some((l) => l === 'filler-0'),
    JSON.stringify(tailLines.slice(-2)));

  const follow = spawnCli(['logs', '-f'], home);
  await sleep(500);
  fs.appendFileSync(logPath, 'followed-line-appears\n');
  await sleep(900);
  check('logs: `-f` prints lines appended after it started (story 10)',
    follow.stdout.includes('followed-line-appears'), JSON.stringify(follow.stdout));

  follow.child.kill('SIGINT');
  const followExit = await waitExit(follow.child, 5000);
  check('logs: Ctrl-C on `-f` only ends the tail (story 10)', followExit === 0 || followExit === null || typeof followExit === 'number',
    `code=${followExit}`);
  check('logs: the daemon is still serving after the follower exited (story 10)',
    (await getJson(HTTP_PORT)).body?.includes('"sessions"') === true);
  const pid = Number(fs.readFileSync(path.join(home, '.whistle-vconsole', 'v2.pid'), 'utf8').trim());
  check('logs: the daemon pid is untouched (story 10)', isAlive(pid), String(pid));

  await probe.ws.close();
  stopDaemon(home);
  await waitDown(HTTP_PORT);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- story 12 + 13: daemon first, whistle plugin later -> proxy, same token --
async function caseCoexistWithPlugin() {
  const home = makeHome();
  const hubBusy = await getJson(9528, '/html2canvas.min.js');
  if (hubBusy.status) {
    check('coexist: skipped because the real hub port 9528 is busy', false, JSON.stringify(hubBusy));
    fs.rmSync(home, { recursive: true, force: true });
    return;
  }

  // the daemon takes the DEFAULT hub port AND the default 0.0.0.0 bind: on macOS
  // a loopback-only bind lets a second wildcard bind succeed, which would hide the
  // collision this case is about
  const up = spawnCli(['start', '--token', TOKEN], home);
  check('coexist: precondition — daemon owns 9528',
    (await waitExit(up.child, 10000)) === 0 && hubFile(home)?.port === 9528, JSON.stringify(hubFile(home)));

  const probe = fakeProbe('coexist-1', 9528);
  await probe.ready;
  await sleep(300);

  // stand-in for the whistle plugin booting inside `w2 start` afterwards:
  // createBackend() collides on 9528 and must attach as a proxy with OUR token
  const script = `
    const { createBackend } = require('./dist/index.cjs');
    createBackend().then((r) => r.backend.handleTool('list_sessions', {}).then((res) => {
      console.log(JSON.stringify({
        mode: r.mode, token: r.token, port: r.port,
        sessions: JSON.parse(res.content[0].text).sessions.map((s) => s.sessionId),
      }));
      process.exit(0);
    })).catch((e) => {
      console.log(JSON.stringify({ error: String((e && e.message) || e) }));
      process.exit(1);
    });
  `;
  const plugin = spawn(process.execPath, ['-e', script], {
    cwd: PKG, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let raw = '';
  plugin.stdout.on('data', (c) => { raw += c.toString(); });
  let pluginErr = '';
  plugin.stderr.on('data', (c) => { pluginErr += c.toString(); });
  const pluginCode = await waitExit(plugin, 15000);
  const attached = (() => { try { return JSON.parse(raw.trim()); } catch { return null; } })();

  check('coexist: the second form attaches in proxy mode instead of failing (story 12)',
    pluginCode === 0 && attached?.mode === 'proxy', `code=${pluginCode} out=${raw.slice(0, 200)} err=${pluginErr.slice(-200)}`);
  check('coexist: the proxy reuses the daemon token from hub.json (story 12)',
    attached?.token === TOKEN, JSON.stringify(attached));
  check('coexist: through the proxy the daemon-side device is visible (story 12)',
    Array.isArray(attached?.sessions) && attached.sessions.includes('coexist-1'), JSON.stringify(attached));

  const inject = await getJson(HTTP_PORT, '/inject.html');
  check('coexist: /inject.html carries the same token as hub.json (story 12)',
    inject.status === 200 && inject.body.includes(`?t=${TOKEN}`), String(inject.body).slice(0, 200));

  const asset = await getJson(9528, '/html2canvas.min.js');
  check('coexist: the hub port still serves the probe asset, no new port (story 13)',
    asset.status === 200 && asset.body.length > 1000, JSON.stringify({ s: asset.status, len: asset.body?.length }));

  await probe.ws.close();
  stopDaemon(home);
  await waitDown(HTTP_PORT);
  await waitDown(9528);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- story 17 + ticket 008: --help covers the whole surface, and no standalone
//     entry hands out a snippet (standalone never injects, ADR-005) -----------
async function casePublishFace() {
  const home = makeHome();

  const help = spawnCli(['--help'], home);
  const helpCode = await waitExit(help.child, 6000);
  check('help: exits 0', helpCode === 0, `code=${helpCode}`);
  for (const needle of ['v2 start', 'v2 stop', 'v2 status', 'v2 logs', '-f', 'stdio']) {
    check(`help: documents \`${needle}\``, help.stderr.includes(needle), help.stderr.slice(-500));
  }
  for (const envName of ['WHISTLE_VCONSOLE_PORT', 'WHISTLE_VCONSOLE_HOST', 'WHISTLE_VCONSOLE_TOKEN']) {
    check(`help: documents ${envName}`, help.stderr.includes(envName), help.stderr.slice(-500));
  }
  check('help: does not advertise commands we chose not to build',
    !/\brestart\b|\buninstall\b/.test(help.stderr), help.stderr.slice(-500));

  const version = spawnCli(['--version'], home);
  const versionCode = await waitExit(version.child, 6000);
  check('version: exits 0 with a single line',
    versionCode === 0 && version.stderr.trim().split('\n').length === 1, JSON.stringify(version.stderr));

  const unknown = spawnCli(['nope'], home);
  const unknownCode = await waitExit(unknown.child, 6000);
  check('unknown command: exits non-zero with the help text',
    unknownCode === 2 && unknown.stderr.includes('unknown command: nope'), `code=${unknownCode}`);

  const hubPort = 9353;
  const stdio = spawnCli(['--port', String(hubPort), '--token', TOKEN], home);
  let up = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !up) {
    const asset = await getJson(hubPort, '/html2canvas.min.js');
    up = asset.status === 200;
    if (!up) { await sleep(120); }
  }
  check('stdio: bare run still owns the hub port (behaviour unchanged)', up);
  check('stdio: prints the external link and the wss rule, not a snippet',
    /probe\.js/.test(stdio.stderr) && /wss/.test(stdio.stderr)
    && !stdio.stderr.includes('import VConsole'), stdio.stderr.slice(-600));
  stdio.child.kill('SIGTERM');
  await waitExit(stdio.child, 6000);
  fs.rmSync(home, { recursive: true, force: true });
}

async function main() {
  const owned = await waitServing(HTTP_PORT, 800);
  if (owned) {
    console.error(`:9527 已被服务（可能是本机 v2 daemon 或 whistle 插件），cli.e2e 需要独占这个端口。`);
    console.error('先 `v2 stop` 或停掉 whistle 再跑。');
    process.exit(1);
  }

  await caseStartForeground();
  await caseStartBackground();
  await caseStartFailsWhenTheHubPortIsStuck();
  await caseStartRefusesWhenPluginOwnsHttpPort();
  await caseStop();
  await caseStopNeverTouchesSomeoneElsesPort();
  await caseStatusThreeStates();
  await caseStatusVersionDrift();
  await caseLogs();
  await caseCoexistWithPlugin();
  await casePublishFace();

  console.log(`\ncli e2e: ${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exit(1); }
  process.exit(0);
}

main().catch((e) => {
  console.error('cli e2e fatal:', e);
  process.exit(1);
});
