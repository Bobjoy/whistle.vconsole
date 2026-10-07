/**
 * Tiny static server + mock API for the demo page. No dependencies.
 *
 * Usage: node server.mjs [port] [--probe-dist <path>]
 * Serves ./public files and copies the built probe bundle to /vconsole.min.js.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const port = Number(args[0]) || 9443;
const probeDistIdx = args.indexOf('--probe-dist');
const probeDist = probeDistIdx > -1 ? args[probeDistIdx + 1] :
  path.resolve(__dirname, '../../packages/vconsole/dist/vconsole.min.js');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${port}`);

  if (u.pathname === '/vconsole.min.js') {
    // read per request: the probe bundle is rebuilt constantly during
    // development, and a startup snapshot makes rebuilt fixes look like
    // they never landed
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-store',
    });
    res.end(fs.readFileSync(probeDist, 'utf8'));
    return;
  }

  if (u.pathname === '/api/test') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        from: u.searchParams.get('from') || 'unknown',
        echoBody: body || null,
        serverTime: Date.now(),
      }));
    });
    return;
  }

  // any page in this directory, so cdn.html (外链 + 隧道示例) is reachable too
  const page = u.pathname === '/' ? '/index.html' : u.pathname;
  if (/^\/[\w.-]+\.html$/.test(page)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, path.basename(page))));
    return;
  }
  // sibling static assets (e.g. vendored vue.global.prod.js for vue.html)
  if (/^\/[\w.-]+\.js$/.test(page)) {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(fs.readFileSync(path.join(__dirname, path.basename(page))));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(port, () => {
  console.log(`demo-h5 listening on http://localhost:${port} (probe from ${probeDist})`);
});
