/**
 * Vite plugin: auto-inject the @bobjoy/vconsole probe into every HTML page in
 * dev mode. Zero changes to your source code.
 *
 * Usage (vite.config.ts):
 *
 *   import vconsoleMcp from '@bobjoy/vconsole-vite';
 *
 *   export default defineConfig({
 *     plugins: [
 *       vconsoleMcp({
 *         serverUrl: 'ws://192.168.x.x:9528?t=<token>',
 *       }),
 *     ],
 *   });
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

/**
 * Minimal structural subset of Vite's `Plugin` type. The returned object is
 * assignable to `Plugin` in user configs; declaring it locally keeps this
 * package free of a hard vite dependency (vite stays a peerDependency).
 */
interface ConnectServer {
  use: (fn: (req: any, res: any, next: () => void) => void) => void;
}
interface DevServer {
  middlewares: ConnectServer;
}
interface IndexHtmlTagResult {
  tag: string;
  attrs?: Record<string, any>;
  children?: string;
  injectTo?: 'head-prepend' | 'head' | 'body-prepend' | 'body';
}
interface VitePluginLike {
  name: string;
  apply?: 'serve' | 'build';
  configureServer?: (server: DevServer) => void;
  transformIndexHtml?: {
    order?: 'pre' | 'post' | null;
    handler?: (html: string, ctx?: any) => string | IndexHtmlTagResult[] | Promise<string | IndexHtmlTagResult[]>;
  } | ((html: string, ctx?: any) => string | IndexHtmlTagResult[] | Promise<string | IndexHtmlTagResult[]>);
}

export interface VconsoleMcpViteOptions {
  /** WebSocket endpoint of the hub, e.g. ws://192.168.x.x:9528 */
  serverUrl: string;
  /** optional label shown in list_sessions */
  deviceName?: string;
  /** hide the vConsole switch button (agent-only debugging) */
  hideUI?: boolean;
  /** only inject into pages whose HTML matches (default: all) */
  include?: RegExp;
  /** skip injection when this matches (takes precedence over include) */
  exclude?: RegExp;
}

const PROBE_MODULE = '@bobjoy/vconsole/dist/vconsole.min.js';

export default function vconsoleMcpPlugin(options: VconsoleMcpViteOptions): VitePluginLike {
  const require = createRequire(import.meta.url);

  let probeCode: string;
  try {
    const probePath = require.resolve(PROBE_MODULE);
    probeCode = fs.readFileSync(probePath, 'utf8');
  } catch (e) {
    throw new Error(
      `[vconsole-vite] cannot resolve ${PROBE_MODULE}. ` +
      'Install it: pnpm add -D @bobjoy/vconsole',
    );
  }

  const initCode = `try { new VConsole(${JSON.stringify({
    serverUrl: options.serverUrl,
    deviceName: options.deviceName,
    hideUI: !!options.hideUI,
  })}); } catch (e) { console.warn('[vconsole-vite]', e); }`;

  const shouldInject = (html: string) => {
    if (options.exclude && options.exclude.test(html)) { return false; }
    if (options.include) { return options.include.test(html); }
    return true;
  };

  return {
    name: 'whistle-vconsole',
    apply: 'serve', // dev only — never ship the probe to production
    configureServer(server) {
      // serve the probe bundle without touching the user's build pipeline
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/@whistle-vconsole/probe.js')) {
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(probeCode);
          return;
        }
        next();
      });
    },
    transformIndexHtml(html) {
      if (!shouldInject(html)) {
        return html;
      }
      return [
        {
          tag: 'script',
          attrs: { src: '/@whistle-vconsole/probe.js' },
          injectTo: 'head-prepend',
        },
        {
          tag: 'script',
          children: initCode,
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}
