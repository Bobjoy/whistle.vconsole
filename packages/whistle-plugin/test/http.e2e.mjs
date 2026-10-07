/**
 * MCP-over-HTTP e2e — the shape both start-up forms serve (whistle plugin and
 * `v2 start`): it drives the shared createHttpService() with the official SDK
 * StreamableHTTP client, covering every read tool, sessionId targeting, the
 * panel/probe assets and the token gateway. This is the regression that guards
 * the `w2 start` deployment and the standalone daemon at the same time.
 *
 * Run: node packages/whistle-plugin/test/http.e2e.mjs
 */

import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocket } from 'ws';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createHttpService } = require('../dist/httpService.cjs');
const { hasAccess, parseDeviceLabel, PROTOCOL_VERSION } = require('../dist/index.cjs');
const buildPanelHtml = require('../lib/panel.js');
const { splitCardText } = buildPanelHtml;

const PORT = 9343;

// flipped by the oversized-result case below so one probe answers get_storage
// with a payload past the agent-side cap
let bigStorage = false;

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

function makeProbe(sessionId, url, title, deviceName = 'http-e2e-phone', protocol = PROTOCOL_VERSION) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}?sid=${sessionId}`);
  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        protocol,
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
    // the get_vue_* tools carry the panel's vue serializer through `eval`;
    // answer per-op so the hub-side chunk/pagination glue is exercised
    let evalAnswer = { result: '42', isException: false, durationMs: 1 };
    if (msg.cmd === 'eval') {
      const expr = (msg.args && msg.args.expression) || '';
      if (expr.indexOf('__vcVue') > -1) {
        if (expr.indexOf('"apps"') > -1) {
          evalAnswer = { result: JSON.stringify({ apps: [{ i: 0, v: 3, name: 'FakeApp', tag: 'div', container: 'div#app', readable: true }] }), isException: false, durationMs: 1 };
        } else if (expr.indexOf('"tree"') > -1) {
          evalAnswer = { result: JSON.stringify({ total: 1, offset: 0, ch: [{ n: 'FakeChild', tag: 'span', cc: 0 }], next: null }), isException: false, durationMs: 1 };
        } else if (expr.indexOf('"state"') > -1) {
          evalAnswer = { result: JSON.stringify({ name: 'FakeApp', len: 13, cut: false, s0: '{"props":{}}' }), isException: false, durationMs: 1 };
        } else if (expr.indexOf('"set"') > -1) {
          evalAnswer = { result: JSON.stringify({ ok: true, key: 'x', value: 1 }), isException: false, durationMs: 1 };
        }
      }
    }
    const answers = {
      eval: evalAnswer,
      get_dom: { found: true, outerHtml: `<body>${title}</body>`, matchedCount: 1 },
      get_storage: bigStorage
        ? { cookies: [], localStorage: [{ key: 'blob', value: 'y'.repeat(70_000) }], sessionStorage: [] }
        : { cookies: [], localStorage: [{ key: 'from', value: sessionId }], sessionStorage: [] },
      page_info: { url, title, referrer: '', userAgent: 'e2e-http', platform: 'test', language: 'zh', viewport: { width: 390, height: 844 }, memory: { usedJSHeapSize: 1, totalJSHeapSize: 2 } },
      screenshot: { format: 'png', width: 9, height: 9, dataBase64: 'iVBORw0KGgo=' },
      replay: { status: 201, statusText: '201', body: '{"created":true}', truncated: false, responseSize: 15, costTime: 7, replayedId: 'a-req-2' },
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
  // --- the access rule lib/runtime.js and hub.ts both call (pure, so it is
  // asserted once rather than through a second bound port) ------------------
  check('access: loopback needs no token',
    hasAccess('/api/tool', '127.0.0.1', 'tk') === true && hasAccess('/mcp', '::1', 'tk') === true
      && hasAccess('/api/tool', '::ffff:127.0.0.1', 'tk') === true);
  check('access: a LAN peer needs the matching ?t=',
    hasAccess('/api/tool?t=tk', '192.168.1.20', 'tk') === true
      && hasAccess('/api/tool', '192.168.1.20', 'tk') === false
      && hasAccess('/api/tool?t=guess', '192.168.1.20', 'tk') === false);
  check('access: an unconfigured token still refuses a LAN peer',
    hasAccess('/api/tool', '10.0.0.5', undefined) === false);

  // --- the ONE HTTP surface both entries share (whistle runtime + v2 start) --
  const service = await createHttpService({
    port: PORT,
    httpPort: PORT + 1,
    host: '127.0.0.1',
    panelHtml: buildPanelHtml(),
  });
  const { backend } = service;

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
  // B reports a NEWER protocol on purpose: ADR-008's soft check must stay
  // invisible for A and visible-but-harmless for B (every B assertion below
  // still has to pass over a mismatched session).
  const b = await makeProbe('dev-b', 'https://example.com/b', 'Page B', 'http-e2e-phone', PROTOCOL_VERSION + 1);
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

  // 1b. protocol soft check (ADR-008): mismatch is a signal, never a cutoff
  check('protocol: matching probe reports no protocolMismatch',
    !('protocolMismatch' in sessions[0]), JSON.stringify(sessions[0]));
  check('protocol: mismatched probe keeps its session and carries the number',
    sessions[1].online === true && sessions[1].protocolMismatch === PROTOCOL_VERSION + 1,
    JSON.stringify(sessions[1]));

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

  // get_vue_* carry the panel's serializer through the plain `eval` command —
  // zero protocol change, so the fake probe answers per-op and the hub-side
  // glue (envelope unwrap, JSON parse, chunk loop) is what these assert
  r = await client.callTool({ name: 'get_vue_tree', arguments: {} });
  check('get_vue_tree lists apps (eval-carried serializer)',
    JSON.parse(text(r)).apps[0].name === 'FakeApp', text(r));
  r = await client.callTool({ name: 'get_vue_tree', arguments: { app: 0 } });
  check('get_vue_tree expands a tree page',
    JSON.parse(text(r)).ch[0].n === 'FakeChild', text(r));
  r = await client.callTool({ name: 'get_vue_state', arguments: { app: 0 } });
  check('get_vue_state returns parsed state (chunk loop hub-side)',
    JSON.parse(text(r)).component === 'FakeApp' && JSON.parse(text(r)).state.props !== undefined, text(r));
  r = await client.callTool({ name: 'set_vue_state', arguments: { app: 0, section: 'data', key: 'x', value: 1 } });
  check('set_vue_state round-trips', JSON.parse(text(r)).ok === true, text(r));
  r = await client.callTool({ name: 'get_page_info', arguments: { sessionId: 'dev-b' } });
  check('get_page_info targets dev-b', JSON.parse(text(r)).url === 'https://example.com/b', text(r));
  r = await client.callTool({ name: 'get_dom', arguments: { sessionId: 'dev-a', selector: 'body' } });
  check('get_dom answered by probe A', JSON.parse(text(r)).outerHtml.includes('Page A'), text(r));
  r = await client.callTool({ name: 'get_storage', arguments: { sessionId: 'dev-b' } });
  check('get_storage answered by probe B', JSON.parse(text(r)).localStorage?.[0]?.value === 'dev-b', text(r));

  // 5b. an oversized result: the 60k cap guards the agent's context window, so it
  // sits on the MCP boundary only — the panel is a human viewer and gets it whole.
  bigStorage = true;
  r = await client.callTool({ name: 'get_storage', arguments: { sessionId: 'dev-a' } });
  check('MCP: a result past 60k is capped for the agent',
    text(r).includes('[truncated by whistle-vconsole]') && text(r).length <= 60_040,
    `${text(r).length} chars`);
  const panelBig = await fetch(`http://127.0.0.1:${PORT + 1}/api/tool`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'get_storage', args: {}, sessionId: 'dev-a' }),
  }).then((x) => x.json());
  const bigText = panelBig.content[0].text;
  check('panel /api/tool: the same result arrives whole and parseable',
    bigText.indexOf('[truncated') === -1 && JSON.parse(bigText).localStorage[0].value.length === 70_000,
    `${bigText.length} chars`);
  check('panel: no longer turns an oversized result into an error line',
    buildPanelHtml().indexOf('结果过大被截断') === -1);
  bigStorage = false;
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

  // 10. replay_request on the HTTP/MCP surface the deployment actually serves
  const tools = await client.listTools();
  check('16 tools registered over HTTP',
    tools.tools.length === 16 && tools.tools.some((t) => t.name === 'replay_request')
      && tools.tools.some((t) => t.name === 'get_vue_state'), String(tools.tools.length));

  r = await client.callTool({ name: 'replay_request', arguments: { sessionId: 'dev-a', requestId: 'evicted-1' } });
  check('replay_request reports an evicted requestId', r.isError === true && /request not found/.test(text(r)), text(r));

  a.ws.send(JSON.stringify({
    type: 'network',
    items: [{ id: 'a-req-1', requestType: 'fetch', method: 'GET', url: 'https://example.com/a/config', status: 200, statusText: '200', startTime: Date.now() - 100, endTime: Date.now() - 50 }],
  }));
  await sleep(150);
  r = await client.callTool({ name: 'replay_request', arguments: { sessionId: 'dev-a', requestId: 'a-req-1' } });
  const replayed = JSON.parse(text(r));
  check('replay_request returns the fresh response over HTTP',
    replayed.status === 201 && replayed.replayedId === 'a-req-2' && replayed.truncated === false, text(r));

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
  // network detail carries the replay entry point (button + confirm + origin tag)
  const panelHtml = buildPanelHtml();
  check('panel: network detail has a replay button wired to the tool',
    panelHtml.indexOf('原样再发一次') > -1 && panelHtml.indexOf("api('replay_request'") > -1);
  check('panel: non-idempotent replay asks first and replayed rows say where they came from',
    /askFirst && !window\.confirm/.test(panelHtml) && panelHtml.indexOf('重放自') > -1);
  check('panel: device card renders the protocol mismatch line',
    /s\.protocolMismatch/.test(panelHtml) && panelHtml.indexOf('协议') > -1);
  // copy affordances: the helper must carry the plain-http execCommand fallback
  // (the panel is routinely opened over LAN http, where navigator.clipboard
  // does not exist), and every entry point must be wired
  check('panel: copy helper falls back to execCommand on insecure contexts',
    /navigator\.clipboard && window\.isSecureContext/.test(panelHtml)
    && panelHtml.indexOf("document.execCommand('copy')") > -1);
  check('panel: copy entries wired (card url / logs / cURL / detail fields / MCP config)',
    panelHtml.indexOf('copyCardUrl(this, event)') > -1 && panelHtml.indexOf('copyLogs(this)') > -1
    && panelHtml.indexOf('复制为cURL') > -1 && panelHtml.indexOf('copyDetailField') > -1
    && panelHtml.indexOf('copyMcp(this)') > -1 && panelHtml.indexOf('copyInfo(this)') > -1);
  // element tab is eval-driven (zero protocol change): the serializer must be
  // embedded, run through eval_js, and keep responses under serializeOne's
  // 2000-char truncation via pagination/chunking
  check('panel: element tab wired (eval-driven tree + chunked outerHTML)',
    panelHtml.indexOf('data-t="element"') > -1 && panelHtml.indexOf('function elementSnippet') > -1
    && panelHtml.indexOf('__vcElem') > -1 && panelHtml.indexOf("api('eval_js'") > -1
    && panelHtml.indexOf("op === 'hslice'") > -1);
  // vue tab walks __vue_app__ (v3, tree needs dev builds) and __vue__ (v2,
  // instance-exposed even in prod builds), reusing the same pagination contract.
  // v1-boundary features: computed/route/pinia state sections, set-writeback,
  // SSE-throttled auto refresh of an open detail.
  check('panel: vue tab wired (v2+v3 walkers + chunked state)',
    panelHtml.indexOf('data-t="vue"') > -1 && panelHtml.indexOf('function vueSnippet') > -1
    && panelHtml.indexOf('__vue_app__') > -1 && panelHtml.indexOf('__vcVue') > -1
    && panelHtml.indexOf("op === 'sslice'") > -1 && panelHtml.indexOf('stateOf2') > -1
    && panelHtml.indexOf('__vue__._isVue') > -1);
  check('panel: vue extras (computed/route/pinia + set writeback + auto refresh)',
    panelHtml.indexOf('computedOf3') > -1 && panelHtml.indexOf('piniaOf') > -1
    && panelHtml.indexOf("op === 'set'") > -1 && panelHtml.indexOf('writeVueState') > -1
    && panelHtml.indexOf('maybeRefreshVue') > -1);
  // the panel html is a build-time template literal: a `\` in it is eaten before
  // the browser sees the script, so a substring match can pass on broken code.
  // Parse the emitted script instead — that is the only check that catches it.
  let panelParseErr = '';
  for (const m of panelHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    try {
      new vm.Script(m[1]);
    } catch (e) {
      panelParseErr = e.message;
      break;
    }
  }
  check('panel: emitted inline script parses', panelParseErr === '', panelParseErr);
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
  service.stop();

  console.log(`\nhttp e2e: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('http e2e fatal:', e);
  process.exit(1);
});
