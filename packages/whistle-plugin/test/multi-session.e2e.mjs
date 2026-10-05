/**
 * Multi-session e2e — reproduces the ZCode multi-session scenario:
 *   1. MCP client A spawns the first server process -> hub mode (owns port)
 *   2. a fake probe connects and pushes data
 *   3. MCP client B spawns a SECOND server process on the SAME port
 *      -> must attach in proxy mode instead of failing with EADDRINUSE
 *   4. client B must see the probe session and execute tools through the hub
 *
 * Run: node packages/whistle-plugin/test/multi-session.e2e.mjs
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';

const PORT = 9341;
const CLI = new URL('../dist/cli.cjs', import.meta.url).pathname;

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

const children = [];
function makeClient(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, '--port', String(PORT)],
    stderr: 'pipe',
  });
  const client = new Client({ name, version: '0.1.0' });
  const handle = { transport, client };
  children.push(handle);
  return handle;
}

async function main() {
  // preflight: a leftover hub on PORT makes client A attach as proxy and
  // silently breaks the whole sequence — fail fast with a clear message
  const probe = new WebSocket(`ws://localhost:${PORT}`);
  let portBusy = false;
  probe.on('open', () => { portBusy = true; probe.terminate(); });
  probe.on('error', () => { /* refused = port free, which is what we want */ });
  await sleep(700);
  if (portBusy) {
    console.error(`port ${PORT} is already held by a whistle-vconsole hub — stop it first:`);
    console.error(`  lsof -ti:${PORT} | xargs kill`);
    process.exit(1);
  }
  probe.terminate();

  // --- session A: hub mode
  const a = makeClient('e2e-hub');
  await a.client.connect(a.transport);
  console.log('client A connected (expect hub mode)');

  // --- fake probe
  const ws = new WebSocket(`ws://localhost:${PORT}?sid=multi-session-1`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', (e) => reject(new Error('probe connect failed: ' + e.message)));
  });
  ws.send(JSON.stringify({
    type: 'hello',
    protocol: 1,
    sessionId: 'multi-session-1',
    deviceName: 'multi-phone',
    probeVersion: 'test',
    page: {
      url: 'https://example.com/multi', title: 'Multi', referrer: '',
      userAgent: 'e2e', platform: 'test', language: 'zh',
      viewport: { width: 390, height: 844, dpr: 3 }, screen: { width: 390, height: 844 },
      visibility: 'visible', online: true,
    },
  }));
  ws.send(JSON.stringify({
    type: 'logs',
    items: [{ id: 'm-log-1', type: 'log', repeated: 0, date: Date.now(), args: ['multi hello'] }],
  }));
  // answer eval commands as soon as they arrive (the hub may forward fast)
  let evalAnswered = 0;
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'cmd' && msg.cmd === 'eval') {
      evalAnswered++;
      ws.send(JSON.stringify({ type: 'result', reqId: msg.reqId, ok: true, data: { result: '42', isException: false, durationMs: 1 } }));
    }
  });
  await sleep(500);

  // --- session B: must attach as proxy on the same port
  const b = makeClient('e2e-proxy');
  await b.client.connect(b.transport);
  console.log('client B connected (expect proxy mode, same port)');

  // B sees the probe session that A's hub owns
  let r = await b.client.callTool({ name: 'list_sessions', arguments: {} });
  let sessions = JSON.parse(r.content[0].text).sessions;
  check('B lists probe from shared hub', sessions.length === 1 && sessions[0].sessionId === 'multi-session-1', JSON.stringify(sessions));

  // B reads logs through the hub
  r = await b.client.callTool({ name: 'get_logs', arguments: {} });
  const logs = JSON.parse(r.content[0].text);
  check('B reads logs pushed to the hub', logs.items.length === 1 && logs.items[0].args[0] === 'multi hello');

  // B executes a command through the hub -> probe answers (global handler above)
  r = await b.client.callTool({ name: 'eval_js', arguments: { expression: '1+1' } });
  const ev = JSON.parse(r.content[0].text);
  check('B eval_js forwarded through hub to probe', ev.result === '42' && ev.isException === false, r.content?.[0]?.text);
  check('probe actually received the forwarded cmd', evalAnswered >= 1);

  // A still works too
  r = await a.client.callTool({ name: 'list_sessions', arguments: {} });
  sessions = JSON.parse(r.content[0].text).sessions;
  check('A still lists the session', sessions.length === 1);

  // --- hub dies: B should self-heal (take over the port) on the next call
  await a.client.close(); // kills A's server process (the hub)
  await sleep(500);

  r = await b.client.callTool({ name: 'list_sessions', arguments: {} });
  sessions = JSON.parse(r.content[0].text).sessions;
  check('B took over the port after hub death (empty session list, no error)', Array.isArray(sessions) && sessions.length === 0, r.content?.[0]?.text);

  // B is now the hub: a probe can connect directly to it
  const ws2 = new WebSocket(`ws://localhost:${PORT}?sid=after-takeover`);
  await new Promise((resolve, reject) => {
    ws2.on('open', resolve);
    ws2.on('error', (e) => reject(new Error('probe reconnect failed: ' + e.message)));
  });
  ws2.send(JSON.stringify({
    type: 'hello',
    protocol: 1,
    sessionId: 'after-takeover',
    deviceName: 'reconnect-phone',
    probeVersion: 'test',
    page: {
      url: 'https://example.com/after', title: 'After', referrer: '',
      userAgent: 'e2e', platform: 'test', language: 'zh',
      viewport: { width: 390, height: 844, dpr: 3 }, screen: { width: 390, height: 844 },
      visibility: 'visible', online: true,
    },
  }));
  await sleep(500);
  r = await b.client.callTool({ name: 'list_sessions', arguments: {} });
  sessions = JSON.parse(r.content[0].text).sessions;
  check('probe connects to B after takeover', sessions.some((s) => s.sessionId === 'after-takeover'), JSON.stringify(sessions));

  // --- same-device takeover: a second connection with the SAME session id
  // (same UA fingerprint) must kick the older connection via the kick msg
  let kickedReceived = false;
  const wsOld = new WebSocket(`ws://localhost:${PORT}?sid=dev-samefinger`);
  await new Promise((resolve, reject) => { wsOld.on('open', resolve); wsOld.on('error', reject); });
  wsOld.send(JSON.stringify({
    type: 'hello', protocol: 1, sessionId: 'dev-samefinger', deviceName: 'same-device',
    probeVersion: 'test',
    page: { url: 'https://example.com/p1', title: 'P1', referrer: '', userAgent: 'same-ua', platform: 'x',
      language: '', viewport: { width: 390, height: 844, dpr: 3 }, screen: { width: 390, height: 844 },
      visibility: 'visible', online: true },
  }));
  await sleep(300);
  wsOld.on('message', (raw) => {
    if (JSON.parse(raw.toString()).type === 'kick') { kickedReceived = true; }
  });
  const oldClosed = new Promise((resolve) => { wsOld.on('close', resolve); });

  const wsNew = new WebSocket(`ws://localhost:${PORT}?sid=dev-samefinger`);
  await new Promise((resolve, reject) => { wsNew.on('open', resolve); wsNew.on('error', reject); });
  wsNew.send(JSON.stringify({
    type: 'hello', protocol: 1, sessionId: 'dev-samefinger', deviceName: 'same-device-new',
    probeVersion: 'test',
    page: { url: 'https://example.com/p2', title: 'P2', referrer: '', userAgent: 'same-ua', platform: 'x',
      language: '', viewport: { width: 390, height: 844, dpr: 3 }, screen: { width: 390, height: 844 },
      visibility: 'visible', online: true },
  }));
  await sleep(500);
  await Promise.race([oldClosed, sleep(2000)]);
  check('same-device takeover sends kick to old probe', kickedReceived);
  check('old connection was closed', wsOld.readyState === WebSocket.CLOSED || wsOld.readyState === WebSocket.CLOSING);

  r = await b.client.callTool({ name: 'list_sessions', arguments: {} });
  sessions = JSON.parse(r.content[0].text).sessions;
  const sames = sessions.filter((s) => s.sessionId === 'dev-samefinger');
  check('session count for the device stays 1', sames.length === 1, JSON.stringify(sames.map((s) => s.sessionId)));
  check('surviving session shows new page', sames[0]?.url === 'https://example.com/p2', JSON.stringify(sames[0]));
  wsOld.terminate();
  wsNew.close();

  console.log(`\nmulti-session e2e: ${passed} passed, ${failed} failed`);
  ws.close();
  ws2.close();
  // kill every spawned server so a re-run (or the hub's TTL timer) never
  // leaves a zombie owning PORT
  for (const h of children) {
    try { await h.client.close(); } catch { /* already closed */ }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('multi-session e2e fatal:', e);
  for (const h of children) {
    try { await h.client.close(); } catch { /* already closed */ }
  }
  process.exit(1);
});
