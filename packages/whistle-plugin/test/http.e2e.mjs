/**
 * MCP-over-HTTP e2e — the shape served by the whistle plugin:
 *   hub (or backend) + stateless Streamable HTTP endpoint, exercised with the
 *   official SDK StreamableHTTP client covering every read tool and sessionId
 *   targeting. This is the regression that guards the `w2 start` deployment.
 *
 * Run: node packages/whistle-plugin/test/http.e2e.mjs
 */

import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebSocket } from 'ws';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createBackend, createMcpServer, parseDeviceLabel, VERSION } = require('../dist/index.cjs');
const buildPanelHtml = require('../lib/panel.js');
const { splitCardText } = buildPanelHtml;

const PORT = 9343;

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

function makeProbe(sessionId, url, title, deviceName = 'http-e2e-phone') {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}?sid=${sessionId}`);
  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        protocol: 1,
        sessionId,
        deviceName,
        probeVersion: 'http-e2e',
        page: {
          url, title, referrer: '', userAgent: 'e2e-http', platform: 'test',
          language: 'zh', viewport: { width: 390, height: 844, dpr: 3 },
          screen: { width: 390, height: 844 }, visibility: 'visible', online: true,
        },
      }));
      resolve(ws);
    });
    ws.on('error', reject);
  });
  // answer every command so hub-side timeouts (30s) can't hang the suite
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== 'cmd') { return; }
    const answers = {
      eval: { result: '42', isException: false, durationMs: 1 },
      get_dom: { found: true, outerHtml: `<body>${title}</body>`, matchedCount: 1 },
      get_storage: { cookies: [], localStorage: [{ key: 'from', value: sessionId }], sessionStorage: [] },
      page_info: { url, title, referrer: '', userAgent: 'e2e-http', platform: 'test', language: 'zh', viewport: { width: 390, height: 844 }, memory: { usedJSHeapSize: 1, totalJSHeapSize: 2 } },
      screenshot: { format: 'png', width: 9, height: 9, dataBase64: 'iVBORw0KGgo=' },
    };
    ws.send(JSON.stringify({
      type: 'result', reqId: msg.reqId, ok: true,
      data: answers[msg.cmd] || {},
      error: answers[msg.cmd] ? undefined : `unknown cmd ${msg.cmd}`,
    }));
  });
  return { ws, ready };
}

async function main() {
  // --- same wiring as packages/whistle-plugin/lib/runtime.js ---------------
  const { backend, hub } = await createBackend({ port: PORT });

  // stateless wiring that mirrors packages/whistle-plugin/lib/runtime.js:
  // a fresh McpServer + transport per request, body parsed first (a shared
  // transport stalls the SDK client on initialize)
  const httpServer = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'POST only (stateless mode)' }));
      return;
    }
    const raw = await new Promise((r) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => r(Buffer.concat(chunks)));
    });
    let parsed;
    try {
      parsed = JSON.parse(raw.toString() || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }
    const server = createMcpServer(backend, VERSION);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: every POST is independent
      enableJsonResponse: true,
    });
    res.on('close', () => {
      try { transport.close(); } catch { /* noop */ }
      try { server.close(); } catch { /* noop */ }
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  });
  await new Promise((resolve) => httpServer.listen(PORT + 1, '127.0.0.1', resolve));

  const client = new Client({ name: 'http-e2e', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT + 1}/mcp`)));

  // --- two fake probes: different fingerprints -> different sessions -------
  const a = await makeProbe('dev-a', 'https://example.com/a', 'Page A');
  await a.ready;
  a.ws.send(JSON.stringify({
    type: 'logs',
    items: [
      { id: 'a-log-1', type: 'log', repeated: 0, date: Date.now(), args: ['from A'] },
      { id: 'a-log-2', type: 'error', repeated: 0, date: Date.now(), args: ['boom A'] },
    ],
  }));
  const b = await makeProbe('dev-b', 'https://example.com/b', 'Page B');
  await b.ready;
  b.ws.send(JSON.stringify({
    type: 'logs',
    items: [{ id: 'b-log-1', type: 'warn', repeated: 0, date: Date.now(), args: ['from B'] }],
  }));
  let aEvals = 0;
  a.ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'cmd' && msg.cmd === 'eval') { aEvals++; }
  });
  await sleep(300);

  const text = (r) => r.content[0].text;

  // 1. list_sessions sees both devices
  let r = await client.callTool({ name: 'list_sessions', arguments: {} });
  let sessions = JSON.parse(text(r)).sessions;
  check('list_sessions shows both probes', sessions.length === 2, JSON.stringify(sessions.map((s) => s.sessionId)));
  check('list_sessions ordered by connection time', sessions[0].sessionId === 'dev-a' && sessions[1].sessionId === 'dev-b',
    JSON.stringify(sessions.map((s) => s.sessionId)));

  // 2. select_session + default targeting follows the active session
  r = await client.callTool({ name: 'select_session', arguments: { sessionId: 'dev-a' } });
  check('select_session ok', JSON.parse(text(r)).ok === true, text(r));
  r = await client.callTool({ name: 'list_sessions', arguments: {} });
  sessions = JSON.parse(text(r)).sessions;
  check('select_session does not reorder the list', sessions[0].sessionId === 'dev-a' && sessions[1].sessionId === 'dev-b',
    JSON.stringify(sessions.map((s) => s.sessionId)));
  r = await client.callTool({ name: 'get_logs', arguments: { limit: 10 } });
  check('get_logs (active session) sees A\'s logs', JSON.parse(text(r)).items.length === 2, text(r));

  // 3. sessionId targeting without switching the active session
  r = await client.callTool({ name: 'get_logs', arguments: { sessionId: 'dev-b', limit: 10 } });
  check('get_logs sessionId=dev-b targets B', JSON.parse(text(r)).items.length === 1 && JSON.parse(text(r)).items[0].args[0] === 'from B', text(r));
  r = await client.callTool({ name: 'get_logs', arguments: { limit: 10 } });
  check('get_logs still defaults to dev-a after targeted call', JSON.parse(text(r)).items.length === 2, text(r));

  // 4. filter + cursor on the targeted session
  r = await client.callTool({ name: 'get_logs', arguments: { sessionId: 'dev-a', level: 'error', limit: 10 } });
  check('get_logs level filter', JSON.parse(text(r)).items.length === 1 && JSON.parse(text(r)).items[0].args[0] === 'boom A', text(r));
  r = await client.callTool({ name: 'get_logs', arguments: { sessionId: 'dev-a', since: 1, limit: 10 } });
  check('get_logs since cursor (numeric, from nextSince)', JSON.parse(text(r)).items.length === 1 && JSON.parse(text(r)).items[0].id === 'a-log-2', text(r));

  // 5. command tools target their session
  r = await client.callTool({ name: 'eval_js', arguments: { sessionId: 'dev-a', expression: '1+1' } });
  check('eval_js targets dev-a', JSON.parse(text(r)).result === '42' && aEvals >= 1, text(r));
  r = await client.callTool({ name: 'get_page_info', arguments: { sessionId: 'dev-b' } });
  check('get_page_info targets dev-b', JSON.parse(text(r)).url === 'https://example.com/b', text(r));
  r = await client.callTool({ name: 'get_dom', arguments: { sessionId: 'dev-a', selector: 'body' } });
  check('get_dom answered by probe A', JSON.parse(text(r)).outerHtml.includes('Page A'), text(r));
  r = await client.callTool({ name: 'get_storage', arguments: { sessionId: 'dev-b' } });
  check('get_storage answered by probe B', JSON.parse(text(r)).localStorage?.[0]?.value === 'dev-b', text(r));
  r = await client.callTool({ name: 'get_network', arguments: { sessionId: 'dev-b' } });
  check('get_network (empty buffer) valid JSON', JSON.parse(text(r)).items.length === 0, text(r));

  // 6. unknown sessionId -> clean error, no crash
  r = await client.callTool({ name: 'get_logs', arguments: { sessionId: 'dev-nope' } });
  check('unknown sessionId -> error result', r.isError === true && /session not found/.test(text(r)), text(r));

  // 7. screenshot returns an MCP image block
  r = await client.callTool({ name: 'screenshot', arguments: { sessionId: 'dev-a' } });
  check('screenshot returns image block', r.content[0].type === 'image' && r.content[0].mimeType === 'image/png', JSON.stringify(r.content[0]).slice(0, 120));

  // 8. wait_for: a new log from B must satisfy the waiter
  const waiter = client.callTool({ name: 'wait_for', arguments: { sessionId: 'dev-b', kind: 'log', contains: 'late-b', timeoutMs: 5000 } });
  await sleep(300);
  b.ws.send(JSON.stringify({ type: 'logs', items: [{ id: 'b-log-2', type: 'log', repeated: 0, date: Date.now(), args: ['late-b arrived'] }] }));
  r = await waiter;
  check('wait_for resolves on matching log', JSON.parse(text(r)).item?.args?.[0] === 'late-b arrived', text(r));

  // 9. wait_for times out cleanly when nothing matches (error result, no crash)
  r = await client.callTool({ name: 'wait_for', arguments: { sessionId: 'dev-b', kind: 'log', contains: 'never-logs-this', timeoutMs: 800 } });
  check('wait_for timeout -> clean error result', r.isError === true && /timeout|timed out|no match/i.test(text(r)), text(r));

  // device labels: Huawei puts "HarmonyOS" between the Android version and the
  // model, which the old single-token regex could not cross -> device/OS vanished
  const HUAWEI_TABLET_UA = 'Mozilla/5.0 (Linux; Android 12; HarmonyOS; DBR-W00; HMSCore 6.16.4.352) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.79 HuaweiBrowser/17.0.8.310 Safari/537.36';
  const HARMONY_NEXT_UA = 'Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile HuaweiBrowser/17.0.3.700';
  const PIXEL_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TD1A.230510.008) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  const LEGACY_UA = 'Mozilla/5.0 (Linux; U; Android 4.0.3; zh-cn; GT-I9000 Build/IML74K) AppleWebKit/534.30 '
    + '(KHTML, like Gecko) Version/4.0 Mobile Safari/534.30';
  check('label: HarmonyOS tablet keeps model + OS',
    parseDeviceLabel(HUAWEI_TABLET_UA) === 'DBR-W00 · HarmonyOS · Chrome 132（HuaweiBrowser 17）', parseDeviceLabel(HUAWEI_TABLET_UA));
  check('label: OpenHarmony device needs no Mobile tail',
    parseDeviceLabel(HARMONY_NEXT_UA) === 'HarmonyOS 5.0 · Chrome 114（HuaweiBrowser 17）', parseDeviceLabel(HARMONY_NEXT_UA));
  check('label: plain Android unchanged',
    parseDeviceLabel(PIXEL_UA) === 'Pixel 7 · Android 13 · Chrome 120', parseDeviceLabel(PIXEL_UA));
  check('label: locale token is not the model',
    parseDeviceLabel(LEGACY_UA) === 'GT-I9000 · Android 4.0.3 · Safari 4.0', parseDeviceLabel(LEGACY_UA));
  check('label: client-hints model wins over frozen K',
    parseDeviceLabel('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      { model: 'MatePad 11', osVersion: '12.0.0' }) === 'MatePad 11 · Android 12 · Chrome 120');
  // iPad asking for the desktop site ships a plain Macintosh UA; only the probe's
  // touch hint separates it from a real Mac (and an old probe must keep the Mac label)
  const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.4 Safari/605.1.15';
  check('label: touch hint turns the Mac UA into an iPad',
    parseDeviceLabel(IPAD_DESKTOP_UA, { isTablet: true }) === 'iPad · Safari 17.4',
    parseDeviceLabel(IPAD_DESKTOP_UA, { isTablet: true }));
  check('label: no touch hint keeps the Mac label as-is',
    parseDeviceLabel(IPAD_DESKTOP_UA) === 'Mac OS X 10.15.7 · Safari 17.4', parseDeviceLabel(IPAD_DESKTOP_UA));

  // session cards: deviceName and the parenthesised product say the same thing
  // twice, so the name stays in the muted slot and only its version moves over
  const split = (label, name) => JSON.stringify(splitCardText(label, name));
  check('card: version moves from the parenthetical to deviceName',
    split('Chrome 146（App ZCode 3.14.4）', '我的电脑') === '{"label":"Chrome 146","muted":"我的电脑 3.14.4"}',
    split('Chrome 146（App ZCode 3.14.4）', '我的电脑'));
  check('card: parenthetical without a version just drops',
    split('Chrome 132（HuaweiBrowser）', '华为平板') === '{"label":"Chrome 132","muted":"华为平板"}',
    split('Chrome 132（HuaweiBrowser）', '华为平板'));
  check('card: deviceName already in the label head shows no muted text',
    split('Pixel 7 · Android 13 · Chrome 120', 'Pixel 7') === '{"label":"Pixel 7 · Android 13 · Chrome 120","muted":""}',
    split('Pixel 7 · Android 13 · Chrome 120', 'Pixel 7'));
  check('card: no deviceName leaves the label alone',
    split('Mac OS X 10.15.7 · Safari 17.4', '') === '{"label":"Mac OS X 10.15.7 · Safari 17.4","muted":""}');
  check('card: label without a parenthetical keeps it',
    split('Chrome 150', '某设备') === '{"label":"Chrome 150","muted":"某设备"}', split('Chrome 150', '某设备'));
  // the panel must run this same implementation (injected by .toString())
  check('card: panel html embeds splitCardText source',
    buildPanelHtml().indexOf('const splitCardText = function splitCardText(label, deviceName)') > -1);
  // generic classes are gone: the OS segment already says PC / standalone browser
  check('label: desktop Chrome shows no PC badge',
    parseDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36')
      === 'Windows 10+ · Chrome 150');
  // only what the OS cannot reveal keeps parens: app containers and the real
  // browser product behind a Chrome kernel
  check('label: WeChat container still named',
    parseDeviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) '
      + 'Mobile/15E148 MicroMessenger/8.0.49(0x18003139) NetType/WIFI') === 'iPhone · iOS 18.4 · App WeChat 8.0');
  check('label: Edge names the product without a PC/Mobile prefix',
    parseDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0') === 'Windows 10+ · Chrome 154（Edge 154）');
  // domestic Chrome-kernel shells: the product token is the only clue it isn't Chrome
  for (const [model, ver, tok, want] of [
    ['SM-S938B', '15', 'SamsungBrowser/29.0.4.3', 'SM-S938B · Android 15 · Chrome 150（SamsungBrowser 29）'],
    ['23127PN0CC', '14', 'MiuiBrowser/16.0.521824', '23127PN0CC · Android 14 · Chrome 150（MiuiBrowser 16）'],
    ['PJD110', '14', 'MQQBrowser/14.3', 'PJD110 · Android 14 · Chrome 150（MQQBrowser 14.3）'],
    ['PGU110', '14', 'UCBrowser/16.5.6.1310', 'PGU110 · Android 14 · Chrome 144（UCBrowser 16.5）'],
  ]) {
    const ua = `Mozilla/5.0 (Linux; Android ${ver}; ${model} Build/Z) AppleWebKit/537.36 `
      + `(KHTML, like Gecko) Version/4.0 Chrome/${tok.startsWith('UC') ? '144' : '150'}.0.0.0 `
      + `Mobile Safari/537.36 ${tok}`;
    check('label: ' + tok + ' named over kernel', parseDeviceLabel(ua) === want, parseDeviceLabel(ua));
  }

  a.ws.close();
  b.ws.close();
  await client.close();
  try { hub.stop(); } catch { /* already stopped */ }
  httpServer.close();

  console.log(`\nhttp e2e: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('http e2e fatal:', e);
  process.exit(1);
});
