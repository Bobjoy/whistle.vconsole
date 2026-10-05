/**
 * End-to-end test:
 *   1. MCP client (stdio) spawns the real `whistle-vconsole` server process
 *   2. a fake probe (Node WS client) connects to the server's WebSocket hub
 *      and replays the full protocol: hello, logs, network, command results
 *   3. every MCP tool is called and its result asserted
 *
 * Run: node packages/whistle-plugin/test/e2e.mjs
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';

const PORT = 9340;
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

// WS_BINARY_MARKER: how the probe ships a binary frame over JSON
const BIN = '__vcb64__:';
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

// ---------------------------------------------------------------------------
// fake probe
// ---------------------------------------------------------------------------

function startFakeProbe() {
  const state = { connected: false, commands: [] };
  const storage = { cookies: { sid: 'abc' }, localStorage: { k: 'v' }, sessionStorage: {} };
  let ws = null;

  const send = (obj) => ws.send(JSON.stringify(obj));

  const connect = () => {
    ws = new WebSocket(`ws://localhost:${PORT}?sid=e2e-session-1`);

    ws.on('error', () => {
      if (!state.connected) {
        setTimeout(connect, 300);
      }
    });

    ws.on('open', () => {
      state.connected = true;
      send({
        type: 'hello',
        protocol: 1,
        sessionId: 'e2e-session-1',
        deviceName: 'e2e-fake-phone',
        probeVersion: '3.16.0-alpha-mcp.1',
        page: {
          url: 'https://example.com/demo', title: 'E2E Demo', referrer: '',
          userAgent: 'e2e-agent', platform: 'test', language: 'zh-CN',
          viewport: { width: 390, height: 844, dpr: 3 }, screen: { width: 390, height: 844 },
          visibility: 'visible', online: true,
        },
      });
      send({
        type: 'logs',
        items: [
          { id: 'log-1', type: 'log', repeated: 0, date: Date.now(), args: ['[demo] page loaded {"href":"https://example.com/demo"}'] },
          { id: 'log-2', type: 'warn', repeated: 0, date: Date.now(), args: ['这是一条 warn'] },
          { id: 'log-3', type: 'error', repeated: 2, date: Date.now(), args: ['Error: demo error', 'Error: oh no'] },
        ],
      });
      send({
        type: 'network',
        items: [
          {
            id: 'req-1', requestType: 'fetch', method: 'GET', url: 'https://example.com/api/test?from=xhr',
            name: 'test', status: 200, statusText: 'OK', costTime: 123, responseSize: 42,
            requestHeader: '{"content-type":"application/json"}', responseHeader: '{"server":"e2e"}',
            postData: 'null', response: '{"ok":true}', startTime: Date.now() - 200, endTime: Date.now(),
          },
          {
            id: 'ws-conn-a', requestType: 'websocket', method: 'WS', url: 'wss://push.example.com/a',
            name: 'a', status: 101, statusText: 'Connected', startTime: Date.now() - 3000, endTime: Date.now(),
            messages: [
              { type: 'send', data: JSON.stringify({ op: 'join', room: '1' }), time: Date.now() - 2000 },
              { type: 'receive', data: JSON.stringify({ op: 'welcome', user: 'u42' }), time: Date.now() - 1500 },
              { type: 'receive', data: BIN + b64([0x00, 0x11, 0x22, 0x33]), time: Date.now() - 1000 },
            ],
          },
          {
            id: 'ws-conn-b', requestType: 'websocket', method: 'WS', url: 'wss://chat.example.com/b',
            name: 'b', status: 101, statusText: 'Connected', startTime: Date.now() - 1000, endTime: Date.now(),
            messages: [
              // a Blob is unreadable until the probe finishes reading it: placeholder first
              { type: 'receive', data: 'Blob(4)', time: Date.now() - 800 },
            ],
          },
        ],
      });
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'cmd') { return; }
      state.commands.push(msg.cmd);
      const reply = (ok, data, error) => send({ type: 'result', reqId: msg.reqId, ok, data, error });
      switch (msg.cmd) {
        case 'eval':
          if (msg.args.expression === 'throw new Error("boom")') {
            reply(true, { result: 'Error: boom', isException: true, durationMs: 1 });
          } else {
            reply(true, { result: '42', isException: false, durationMs: 2 });
          }
          break;
        case 'get_dom':
          reply(true, { selector: msg.args.selector, matched: 1, returned: 1, nodes: [{ tag: 'h1', id: 'title', outerHTML: '<h1 id="title">Hello</h1>' }] });
          break;
        case 'get_storage':
          reply(true, storage);
          break;
        case 'set_storage': {
          const bucket = { local: 'localStorage', session: 'sessionStorage', cookie: 'cookies' }[msg.args.storage];
          if (!bucket) { reply(false, undefined, `unknown storage: ${msg.args.storage}`); break; }
          if (bucket === 'cookies' && msg.args.key === 'httponly') {
            reply(false, undefined, 'Error: cookie "httponly" is not writable from JS (HttpOnly?)');
            break;
          }
          storage[bucket][msg.args.key] = msg.args.value;
          reply(true, { storage: msg.args.storage, key: msg.args.key, value: storage[bucket][msg.args.key] });
          break;
        }
        case 'page_info':
          reply(true, { url: 'https://example.com/demo', title: 'E2E Demo', userAgent: 'e2e-agent', viewport: { width: 390, height: 844, dpr: 3 } });
          break;
        case 'screenshot':
          // 1x1 red PNG
          reply(true, { format: 'png', width: 1, height: 1, dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' });
          break;
        default:
          reply(false, undefined, 'unknown cmd');
      }
    });
  };

  connect();
  return { ws: () => ws, state };
}

// ---------------------------------------------------------------------------
// test driver
// ---------------------------------------------------------------------------

async function main() {
  const probe = startFakeProbe();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, '--port', String(PORT)],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e-client', version: '0.1.0' });
  await client.connect(transport);
  console.log('MCP client connected over stdio');

  await sleep(800); // let the fake probe connect & push data

  // --- list_sessions
  let r = await client.callTool({ name: 'list_sessions', arguments: {} });
  let sessions = JSON.parse(r.content[0].text).sessions;
  check('list_sessions shows probe', sessions.length === 1 && sessions[0].sessionId === 'e2e-session-1');
  check('list_sessions marks active', sessions[0].active === true);
  check('list_sessions has url/ua', sessions[0].url === 'https://example.com/demo' && sessions[0].userAgent === 'e2e-agent');

  // --- get_logs
  r = await client.callTool({ name: 'get_logs', arguments: {} });
  let logs = JSON.parse(r.content[0].text);
  check('get_logs returns 3 items', logs.items.length === 3, JSON.stringify(logs));
  check('get_logs cursor present', typeof logs.nextSince === 'number' && logs.nextSince > 0);
  const since = logs.nextSince;

  r = await client.callTool({ name: 'get_logs', arguments: { level: 'error' } });
  logs = JSON.parse(r.content[0].text);
  check('get_logs level filter', logs.items.length === 1 && logs.items[0].id === 'log-3');

  r = await client.callTool({ name: 'get_logs', arguments: { keyword: 'warn' } });
  logs = JSON.parse(r.content[0].text);
  check('get_logs keyword filter', logs.items.length === 1 && logs.items[0].type === 'warn');

  r = await client.callTool({ name: 'get_logs', arguments: { since } });
  logs = JSON.parse(r.content[0].text);
  check('get_logs since cursor excludes old', logs.items.length === 0);

  // --- wait_for (waiter fires only on NEW items)
  const waitPromise = client.callTool({ name: 'wait_for', arguments: { kind: 'log', contains: 'late arrival', timeoutMs: 5000 } });
  await sleep(300);
  probe.ws().send(JSON.stringify({ type: 'logs', items: [{ id: 'log-4', type: 'log', repeated: 0, date: Date.now(), args: ['late arrival event'] }] }));
  r = await waitPromise;
  const waited = JSON.parse(r.content[0].text);
  check('wait_for returns matching new log', waited.item && waited.item.args[0] === 'late arrival event', JSON.stringify(waited));

  // --- get_network
  r = await client.callTool({ name: 'get_network', arguments: {} });
  let net = JSON.parse(r.content[0].text);
  check('get_network lists request', net.items.length === 3 && net.items.some((i) => i.id === 'req-1' && i.status === 200));
  check('get_network list rows are light', net.items[0].response === undefined
    && net.items[0].requestHeader === undefined && net.items[0].postData === undefined);
  check('get_network row carries bucket', net.items.find((i) => i.id === 'req-1').bucket === 'xhr'
    && net.items.find((i) => i.id === 'req-1').requestType === 'fetch');

  r = await client.callTool({ name: 'get_network', arguments: { requestId: 'req-1' } });
  const detail = JSON.parse(r.content[0].text);
  check('get_network detail has bodies', detail.response === '{"ok":true}' && detail.costTime === 123);

  r = await client.callTool({ name: 'get_network', arguments: { urlFilter: 'nomatch' } });
  net = JSON.parse(r.content[0].text);
  check('get_network urlFilter', net.items.length === 0);

  r = await client.callTool({ name: 'get_network', arguments: { type: 'xhr' } });
  net = JSON.parse(r.content[0].text);
  check('get_network type=xhr matches fetch', net.items.length === 1 && net.items[0].id === 'req-1');

  r = await client.callTool({ name: 'get_network', arguments: { type: 'css' } });
  net = JSON.parse(r.content[0].text);
  check('get_network type=css excludes fetch', net.items.length === 0);

  // --- ws_frames
  r = await client.callTool({ name: 'ws_frames', arguments: {} });
  let wf = JSON.parse(r.content[0].text);
  check('ws_frames streams all frames', wf.frames.length === 4 && wf.nextSince > 0 && wf.oldestSeq >= 0, JSON.stringify(wf));
  check('ws_frames binary frame is base64', wf.frames.some((f) => f.data === Buffer.from([0x00, 0x11, 0x22, 0x33]).toString('base64')));
  check('ws_frames seq is per-connection', wf.frames.filter((f) => f.wsUrl === 'wss://push.example.com/a').length === 3);

  r = await client.callTool({ name: 'ws_frames', arguments: { wsUrl: 'wss://chat.example.com/b' } });
  wf = JSON.parse(r.content[0].text);
  check('ws_frames wsUrl filter', wf.frames.length === 1 && wf.frames[0].wsUrl === 'wss://chat.example.com/b');

  // time cursor: last frame of conn-a is 1000ms ago; filter it out and only the two newer frames of a + one of b remain
  r = await client.callTool({ name: 'ws_frames', arguments: { sinceFrameTime: Date.now() - 1000 } });
  wf = JSON.parse(r.content[0].text);
  check('ws_frames sinceFrameTime cursor excludes old frames', wf.frames.every((f) => f.time > Date.now() - 1000));

  // empty session shape: a session with no WS frames still returns a well-formed object
  r = await client.callTool({ name: 'ws_frames', arguments: { wsUrl: 'wss://absent.example.com/none' } });
  wf = JSON.parse(r.content[0].text);
  check('ws_frames no-match returns empty frames', wf.frames.length === 0 && wf.nextSince === 0);

  // the probe patches a Blob frame in place once its bytes become readable: the
  // hub has to refresh the frame it already recorded, not append a second one
  probe.ws().send(JSON.stringify({
    type: 'network',
    items: [{
      id: 'ws-conn-b', requestType: 'websocket', method: 'WS', url: 'wss://chat.example.com/b',
      name: 'b', status: 101, startTime: Date.now() - 1000, endTime: Date.now(),
      messages: [{ type: 'receive', data: BIN + b64([0xde, 0xad, 0xbe, 0xef]), time: Date.now() - 800 }],
    }],
  }));
  await sleep(200);
  r = await client.callTool({ name: 'ws_frames', arguments: { wsUrl: 'wss://chat.example.com/b' } });
  wf = JSON.parse(r.content[0].text);
  check('ws_frames refreshes a patched-in Blob frame instead of duplicating it',
    wf.frames.length === 1 && wf.frames[0].data === b64([0xde, 0xad, 0xbe, 0xef]), JSON.stringify(wf));

  // a binary frame the probe had to cap carries its original byte count
  const capped = new Uint8Array(8192).fill(0xab);
  probe.ws().send(JSON.stringify({
    type: 'network',
    items: [{
      id: 'ws-conn-a', requestType: 'websocket', method: 'WS', url: 'wss://push.example.com/a',
      name: 'a', status: 101, startTime: Date.now() - 3000, endTime: Date.now(),
      messages: [
        { type: 'send', data: JSON.stringify({ op: 'join', room: '1' }), time: Date.now() - 2000 },
        { type: 'receive', data: JSON.stringify({ op: 'welcome', user: 'u42' }), time: Date.now() - 1500 },
        { type: 'receive', data: BIN + b64([0x00, 0x11, 0x22, 0x33]), time: Date.now() - 1000 },
        { type: 'receive', data: BIN + b64(capped) + ':20000', time: Date.now() - 400 },
      ],
    }],
  }));
  await sleep(200);
  r = await client.callTool({ name: 'ws_frames', arguments: { wsUrl: 'wss://push.example.com/a' } });
  wf = JSON.parse(r.content[0].text);
  const cappedFrame = wf.frames[wf.frames.length - 1];
  check('ws_frames keeps base64 and original size of a capped binary frame',
    cappedFrame.data === b64(capped) && cappedFrame.totalBytes === 20000,
    JSON.stringify({ len: (cappedFrame.data || '').length, totalBytes: cappedFrame.totalBytes }));

  // --- eval_js
  r = await client.callTool({ name: 'eval_js', arguments: { expression: '1+1' } });
  const ev = JSON.parse(r.content[0].text);
  check('eval_js returns result', ev.result === '42' && ev.isException === false);
  check('probe received eval cmd', probe.state.commands.includes('eval'));

  r = await client.callTool({ name: 'eval_js', arguments: { expression: 'throw new Error("boom")' } });
  const evErr = JSON.parse(r.content[0].text);
  check('eval_js reports exception flag', evErr.isException === true && evErr.result === 'Error: boom');

  // --- get_dom
  r = await client.callTool({ name: 'get_dom', arguments: { selector: 'h1' } });
  const dom = JSON.parse(r.content[0].text);
  check('get_dom returns nodes', dom.matched === 1 && dom.nodes[0].tag === 'h1');

  // --- get_storage
  r = await client.callTool({ name: 'get_storage', arguments: {} });
  const st = JSON.parse(r.content[0].text);
  check('get_storage returns cookies+ls', st.cookies.sid === 'abc' && st.localStorage.k === 'v');

  // --- set_storage
  r = await client.callTool({ name: 'set_storage', arguments: { storage: 'local', key: 'theme', value: 'dark' } });
  let written = JSON.parse(r.content[0].text);
  check('set_storage echoes written value', written.storage === 'local' && written.key === 'theme' && written.value === 'dark', r.content[0].text);
  r = await client.callTool({ name: 'get_storage', arguments: {} });
  check('set_storage persists into the page store', JSON.parse(r.content[0].text).localStorage.theme === 'dark');
  r = await client.callTool({ name: 'set_storage', arguments: { storage: 'cookie', key: 'httponly', value: 'x' } });
  check('set_storage surfaces a refused cookie write', r.isError === true && /HttpOnly/.test(r.content[0].text), r.content[0].text);

  // --- get_page_info
  r = await client.callTool({ name: 'get_page_info', arguments: {} });
  const info = JSON.parse(r.content[0].text);
  check('get_page_info', info.url === 'https://example.com/demo' && info.viewport.dpr === 3);

  // --- vendored html2canvas: the hub port answers plain GETs too, which is
  //     what lets the probe load it locally instead of from a CDN
  const asset = await fetch(`http://localhost:${PORT}/html2canvas.min.js`);
  const assetText = await asset.text();
  check('hub serves vendored html2canvas on the probe port',
    asset.status === 200
      && /^application\/javascript/.test(asset.headers.get('content-type') || '')
      && assetText.startsWith('/*!')
      && assetText.includes('html2canvas 1.4.1'),
    `${asset.status} ${asset.headers.get('content-type')} ${assetText.slice(0, 40)}`);
  check('other paths on the hub port still 404', (await fetch(`http://localhost:${PORT}/probe.js`)).status === 404);

  // --- screenshot (image content block)
  r = await client.callTool({ name: 'screenshot', arguments: { format: 'png' } });
  const img = r.content[0];
  check('screenshot returns image block', img.type === 'image' && img.mimeType === 'image/png' && img.data.startsWith('iVBOR'));

  // --- select_session error path
  r = await client.callTool({ name: 'select_session', arguments: { sessionId: 'nope' } });
  check('select_session rejects unknown id', r.isError === true);

  console.log(`\ne2e result: ${passed} passed, ${failed} failed`);
  await client.close();
  probe.ws().close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('e2e fatal:', e);
  process.exit(1);
});
