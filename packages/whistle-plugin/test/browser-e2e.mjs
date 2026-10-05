/**
 * Real-browser E2E driver.
 *
 * Spawns the MCP server (stdio client), waits for a real browser probe to
 * connect, then exercises every tool against the live page and saves a
 * screenshot to /tmp/vcm-screenshot.png.
 *
 * Run: node examples/demo-h5/browser-e2e.mjs
 * (before: node examples/demo-h5/server.mjs 9443 &  then open the page in a browser)
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';

const PORT = 9346;
const CLI = new URL('../dist/cli.cjs', import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(client, name, args) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args || {} });
  const ms = Date.now() - t0;
  const text = r.content?.map((c) => c.type === 'text' ? c.text : `[${c.type}:${c.mimeType || ''}]`).join('\n') || '';
  console.log(`\n### ${name} ${args ? JSON.stringify(args) : ''} (${ms}ms)${r.isError ? ' [isError]' : ''}`);
  console.log(text.length > 2000 ? text.slice(0, 2000) + ' …' : text);
  return r;
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, '--port', String(PORT)],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'browser-e2e', version: '0.1.0' });
  await client.connect(transport);
  console.log('MCP client connected; waiting for a browser probe to show up...');

  // wait for the browser probe
  let session = null;
  for (let i = 0; i < 60; i++) {
    const r = await client.callTool({ name: 'list_sessions', arguments: {} });
    const sessions = JSON.parse(r.content[0].text).sessions;
    if (sessions.length > 0) {
      session = sessions[0];
      break;
    }
    await sleep(1000);
  }
  if (!session) {
    console.error('no probe session appeared within 60s');
    process.exit(1);
  }
  console.log('probe connected:', JSON.stringify(session, null, 2));

  // 1. page info
  await call(client, 'get_page_info');

  // 2. real eval: read URL + set a marker
  await call(client, 'eval_js', { expression: 'location.href' });
  await call(client, 'eval_js', { expression: 'window.__BROWSER_E2E__ = 42; window.__BROWSER_E2E__ * 2' });

  // 3. trigger console logs via eval (clicks the demo button)
  await call(client, 'eval_js', { expression: 'document.getElementById("btn-log").click()' });
  await call(client, 'eval_js', { expression: 'document.getElementById("btn-error").click()' });

  // 4. start the waiter FIRST, then trigger a fetch through the page
  const waitPromise = client.callTool({ name: 'wait_for', arguments: { kind: 'network', urlFilter: 'api/test', timeoutMs: 10000 } });
  await sleep(300);
  await call(client, 'eval_js', { expression: 'document.getElementById("btn-fetch").click()' });
  const wr = await waitPromise;
  if (wr.isError) {
    console.error('wait_for errored:', wr.content?.[0]?.text);
    process.exit(1);
  }
  const reqId = JSON.parse(wr.content[0].text).item.id;

  // 6. logs since the beginning
  await call(client, 'get_logs', { limit: 10 });
  await call(client, 'get_logs', { level: 'error', limit: 5 });

  // 7. network list + full detail
  await call(client, 'get_network', { limit: 5 });
  await call(client, 'get_network', { requestId: reqId });

  // 8. DOM
  await call(client, 'get_dom', { selector: 'button', limit: 3 });

  // 9. storage
  await call(client, 'eval_js', { expression: 'document.getElementById("btn-storage").click()' });
  await call(client, 'get_storage');

  // 10. screenshot
  const sr = await call(client, 'screenshot', { format: 'png' });
  const img = sr.content?.[0];
  if (img && img.type === 'image') {
    fs.writeFileSync('/tmp/vcm-screenshot.png', Buffer.from(img.data, 'base64'));
    console.log('\nscreenshot saved to /tmp/vcm-screenshot.png (' + img.data.length + ' base64 chars)');
  } else {
    console.error('\nscreenshot FAILED');
  }

  await client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('browser e2e fatal:', e);
  process.exit(1);
});
