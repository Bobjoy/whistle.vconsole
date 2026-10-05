/**
 * @bobjoy/whistle.vconsole — the whistle-vconsole runtime lives inside whistle.
 *
 * When whistle loads this plugin (i.e. on `w2 start`), it boots:
 *   - the probe Hub on ws://<lan>:9528 (phones connect here)
 *   - an MCP Streamable HTTP endpoint on http://127.0.0.1:9527/mcp
 *     (AI agents connect here — MCP starts and dies together with whistle)
 *   - the device panel with a per-session debugging drawer on :9527/
 *   - the probe assets used by rules.txt (/inject.html, /probe.js), so proxied
 *     H5 pages get the vConsole probe without importing anything
 *
 * whistle's own plugin UI entry redirects to the panel.
 */

exports.uiServer = function uiServer(server, options) {
  const runtime = require('./lib/runtime').boot();

  // whistle Plugins entry → the panel
  server.on('request', (req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(302, { Location: `http://127.0.0.1:${runtime.port}/` });
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', panel: `http://127.0.0.1:${runtime.port}/` }));
  });
};
