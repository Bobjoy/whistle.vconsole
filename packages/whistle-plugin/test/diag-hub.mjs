import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('../dist/cli.cjs', import.meta.url).pathname, '--port', '9330'],
  stderr: 'pipe',
});
const client = new Client({ name: 'diag', version: '0.0.1' });
await client.connect(transport);

const r = await client.callTool({ name: 'list_sessions', arguments: {} });
const sessions = JSON.parse(r.content[0].text).sessions;
console.log('sessions:', JSON.stringify(sessions.map((s) => ({
  id: s.sessionId, device: s.deviceName, label: s.deviceLabel, online: s.online, active: s.active,
  url: (s.url || '').slice(0, 60), logs: s.logCount, net: s.networkCount,
})), null, 1));

const w = await client.callTool({ name: 'wait_for', arguments: { kind: 'log', contains: '__never_matches__', timeoutMs: 1500 } });
console.log('wait_for (timeout expected):', w.isError ? w.content[0].text : w.content[0].text.slice(0, 120));

const l = await client.callTool({ name: 'get_logs', arguments: { limit: 2 } });
console.log('get_logs:', l.isError ? l.content[0].text : l.content[0].text.slice(0, 120));

await client.close();
process.exit(0);
