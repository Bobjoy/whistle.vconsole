/**
 * Proxy-mode smoke test against a LIVE hub (e.g. the one ZCode spawned).
 * Spawns a second MCP process on the same port -> attaches as proxy ->
 * calls every tool. Run: node packages/whistle-plugin/test/proxy-smoke.mjs
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';

const PORT = 9345;
const CLI = new URL('../dist/cli.cjs', import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(client, name, args) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args || {} });
  const ms = Date.now() - t0;
  const brief = r.content?.map((c) => c.type === 'text'
    ? c.text.slice(0, 400)
    : `[${c.type}:${c.mimeType} ${c.data?.length || 0} b64]`).join(' | ');
  console.log(`\n### ${name} ${args ? JSON.stringify(args).slice(0, 120) : ''} (${ms}ms)${r.isError ? ' [isError]' : ''}`);
  console.log(brief);
  return r;
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, '--port', String(PORT)],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'proxy-smoke', version: '0.1.0' });
  await client.connect(transport);
  console.log('second MCP process connected (should be proxy mode, sharing the ZCode hub)');

  let failures = 0;
  const expect = async (name, args, condFn, label) => {
    const r = await call(client, name, args);
    const ok = !r.isError && condFn(r);
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok' : 'FAIL'}  ${label}`);
    return r;
  };

  // wait for the probe to be visible; several pages may be connected
  // (e.g. the user's phone/WeChat) — target OUR browser session explicitly
  let session = null;
  for (let i = 0; i < 30; i++) {
    const r = await client.callTool({ name: 'list_sessions', arguments: {} });
    const sessions = JSON.parse(r.content[0].text).sessions;
    const mine = sessions.find((s) => s.deviceName === 'demo-browser' && s.online);
    if (mine) {
      session = mine;
      if (!mine.active) {
        const sel = await client.callTool({ name: 'select_session', arguments: { sessionId: mine.sessionId } });
        console.log('selected our browser session:', sel.content[0].text.slice(0, 120));
      }
      break;
    }
    await sleep(1000);
  }
  if (!session) { console.error('no demo-browser probe session appeared'); process.exit(1); }
  console.log('\nprobe session (seen through proxy):', session.sessionId, session.url);

  await expect('get_page_info', {}, (r) => r.content[0].text.includes('"viewport"'), 'page info ok');
  await expect('eval_js', { expression: 'location.href' }, (r) => r.content[0].text.includes('localhost:9443'), 'eval reads real URL');
  await expect('eval_js', { expression: 'window.__SMOKE__ = 7 * 6' }, (r) => r.content[0].text.includes('42'), 'eval returns 42');
  await expect('get_logs', { limit: 5 }, (r) => r.content[0].text.includes('"items"'), 'logs stream alive');
  // produce our own log so the keyword assertion never depends on page state
  await expect('eval_js', { expression: 'document.getElementById("btn-log").click()' }, (r) => !r.isError, 'btn-log clicked');
  await sleep(400);
  await expect('get_logs', { keyword: '点击了日志按钮', limit: 5 }, (r) => r.content[0].text.includes('点击了日志按钮'), 'logs keyword filter');
  // network list is asserted after the XHR is triggered below (fresh buffer)

  // start the waiter FIRST (do not await), then trigger the XHR
  const wrPromise = client.callTool({ name: 'wait_for', arguments: { kind: 'network', urlFilter: 'from=xhr', timeoutMs: 15000 } });
  await sleep(300);
  await client.callTool({ name: 'eval_js', arguments: { expression: 'document.getElementById("btn-xhr").click()' } });
  const wres = await wrPromise;
  const xhrOk = !wres.isError && wres.content[0].text.includes('api/test');
  if (!xhrOk) failures++;
  console.log(`\n### wait_for (network) -> ${wres.isError ? 'isError: ' + wres.content[0].text : 'matched'}`);
  console.log(`  ${xhrOk ? 'ok' : 'FAIL'}  wait_for caught the new XHR`);

  await expect('get_network', { urlFilter: 'api/test', limit: 3 }, (r) => r.content[0].text.includes('api/test'), 'network list captured');

  const net = await client.callTool({ name: 'get_network', arguments: { urlFilter: 'from=xhr', limit: 1 } });
  const firstReq = JSON.parse(net.content[0].text).items[0];
  if (!firstReq) {
    failures++;
    console.log('\n### get_network detail -> FAIL: no from=xhr request in buffer');
  } else {
    const detail = await client.callTool({ name: 'get_network', arguments: { requestId: firstReq.id } });
    const dOk = !detail.isError && detail.content[0].text.includes('getData');
    if (!dOk) failures++;
    console.log(`\n### get_network detail -> ${dOk ? 'has request detail' : detail.content[0].text}\n  ${dOk ? 'ok' : 'FAIL'}  request detail has postData/response`);
  }

  await expect('get_dom', { selector: 'button', limit: 2 }, (r) => r.content[0].text.includes('btn-log'), 'DOM query ok');
  await expect('eval_js', { expression: 'document.getElementById("btn-storage").click()' }, (r) => !r.isError, 'storage write triggered');
  await expect('get_storage', {}, (r) => r.content[0].text.includes('demo_key'), 'storage read ok');

  const sr = await client.callTool({ name: 'screenshot', arguments: { format: 'png' } });
  const img = sr.content?.[0];
  const sOk = img && img.type === 'image';
  if (sOk) {
    fs.writeFileSync('/tmp/vcm-proxy-screenshot.png', Buffer.from(img.data, 'base64'));
    console.log(`\n### screenshot -> image block (${img.data.length} b64 chars), saved /tmp/vcm-proxy-screenshot.png\n  ok  screenshot via proxy`);
  } else {
    failures++;
    console.log(`\n### screenshot -> FAILED ${sr.content?.[0]?.text || ''}\n  FAIL  screenshot via proxy`);
  }

  console.log(`\nproxy smoke: ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
  await client.close();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('proxy smoke fatal:', e);
  process.exit(1);
});
