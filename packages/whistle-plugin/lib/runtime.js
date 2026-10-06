/**
 * Plugin runtime singleton: boots the hub + the HTTP surface inside the whistle
 * process, so everything starts and stops together with `w2 start`.
 *
 * Only whistle-specific things live here — the `boot()` singleton and the pfork
 * takeover retry. The panel, /mcp, /api/*, /probe.js, /inject.html and the token
 * gateway are the shared `createHttpService()` (src/httpService.ts), the same
 * one `v2 start` runs.
 *
 * A globalThis flag keeps whistle's hot plugin reloads from double-binding the
 * ports: after an upgrade, `w2 restart` picks up the new code.
 */

const http = require('http');
const { createHttpService } = require('../dist/httpService.cjs');
const buildPanelHtml = require('./panel');

const MCP_HTTP_PORT = 9527;

const state = {
  booted: false,
  readyPromise: null,
  runtime: null,
};

function log(msg) {
  console.error(`[whistle.vconsole] ${msg}`);
}

/** True when something on :9527 already answers like our own panel does. */
function alreadyServing() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: MCP_HTTP_PORT, path: '/api/sessions', timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(res.statusCode === 200 && body.indexOf('"sessions"') >= 0));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function boot() {
  if (state.booted) {
    return state.runtime;
  }
  state.booted = true;
  // Never rethrow: whistle loads this hook in more than one process, and an
  // unhandled rejection here would take the whole proxy down with it.
  state.readyPromise = start().catch(async (e) => {
    if (e && e.code === 'EADDRINUSE' && await alreadyServing()) {
      log(`another whistle process serves :${MCP_HTTP_PORT}, retrying in 10s`);
      state.booted = false; // the owner may die (whistle restarts one process); take over then
      setTimeout(boot, 10000).unref();
      return { port: MCP_HTTP_PORT };
    }
    log(`runtime failed to start: ${(e && e.stack) || e}`);
    state.booted = false; // allow a retry on the next uiServer call
    return { port: MCP_HTTP_PORT };
  });
  state.runtime = { port: MCP_HTTP_PORT, ready: state.readyPromise };
  return state.runtime;
}

async function start() {
  const service = await createHttpService({
    httpPort: MCP_HTTP_PORT,
    panelHtml: buildPanelHtml(),
    log,
  });

  return {
    port: service.port,
    hubPort: service.hubPort,
    mode: service.mode,
    ready: Promise.resolve(),
    stop() { service.stop(); },
  };
}

module.exports = { boot };
