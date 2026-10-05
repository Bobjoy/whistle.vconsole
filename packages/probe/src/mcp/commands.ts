/**
 * In-page command implementations invoked by the MCP server.
 */

import type {
  EvalResult, DomResult, DomNodeInfo, StorageData, StorageKind, SetStorageResult, PageInfo, ScreenshotResult,
} from '@bobjoy/vconsole-protocol';
import { serializeOne } from './serialize';

// ---------------------------------------------------------------------------
// eval
// ---------------------------------------------------------------------------

export function evalExpression(expr: string): EvalResult {
  const start = Date.now();
  let result: any;
  let isException = false;
  let exceptionMsg = '';

  try {
    // indirect eval -> global scope, same as the vConsole command line
    result = (0, eval)(expr);
  } catch (e: any) {
    isException = true;
    exceptionMsg = `${(e && e.name) || 'Error'}: ${(e && e.message) || String(e)}`;
  }

  const durationMs = Date.now() - start;
  return {
    result: isException ? exceptionMsg : serializeOne(result),
    isException,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const DOM_MAX_NODES = 20;
const DOM_MAX_HTML_CHARS = 5000;

export function getDom(selector: string, limit?: number): DomResult {
  const maxNodes = Math.min(Math.max(limit || DOM_MAX_NODES, 1), 50);
  const nodes = document.querySelectorAll(selector);
  const out: DomNodeInfo[] = [];
  const total = nodes.length;
  const count = Math.min(total, maxNodes);

  for (let i = 0; i < count; i++) {
    const el = <Element>nodes[i];
    let html = '';
    try {
      html = el.outerHTML;
    } catch (e) {
      html = '[outerHTML error]';
    }
    if (html.length > DOM_MAX_HTML_CHARS) {
      html = html.slice(0, DOM_MAX_HTML_CHARS) + `…[truncated](+${html.length - DOM_MAX_HTML_CHARS} chars)`;
    }
    out.push({
      tag: el.tagName ? el.tagName.toLowerCase() : '?',
      id: el.id || undefined,
      classes: el.classList && el.classList.length ? Array.from(el.classList).join(' ') : undefined,
      outerHTML: html,
      childElementCount: el.childElementCount,
    });
  }

  return { selector, matched: total, returned: out.length, nodes: out };
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

function parseCookies(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = document.cookie || '';
    raw.split(';').forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx < 0) { return; }
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k) { out[k] = decodeURIComponent(v); }
    });
  } catch (e) { /* ignore */ }
  return out;
}

function readWebStorage(store: Storage | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!store) { return out; }
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k !== null) {
        out[k] = store.getItem(k) || '';
      }
    }
  } catch (e) { /* ignore (privacy mode etc.) */ }
  return out;
}

export function getStorage(): StorageData {
  let ls: Storage | null = null;
  let ss: Storage | null = null;
  try { ls = window.localStorage; } catch (e) { /* ignore */ }
  try { ss = window.sessionStorage; } catch (e) { /* ignore */ }
  return {
    cookies: parseCookies(),
    localStorage: readWebStorage(ls),
    sessionStorage: readWebStorage(ss),
  };
}

/**
 * Write one entry and report back what the page actually holds — a cookie
 * write can be refused (HttpOnly) or scoped away (different path), and quota
 * or privacy mode can reject a storage write, so the read-back is the truth.
 */
export function setStorage(kind: StorageKind, key: string, value: string): SetStorageResult {
  if (!key) {
    throw new Error('key is required');
  }
  if (kind === 'cookie') {
    document.cookie = `${key}=${encodeURIComponent(value)}; path=/`;
    const after = parseCookies()[key];
    if (after === undefined) {
      throw new Error(`cookie "${key}" is not writable from JS (HttpOnly?)`);
    }
    return { storage: kind, key, value: after };
  }
  if (kind !== 'local' && kind !== 'session') {
    throw new Error(`unknown storage: ${kind}`);
  }
  const store = kind === 'local' ? window.localStorage : window.sessionStorage;
  store.setItem(key, value);
  return { storage: kind, key, value: store.getItem(key) || '' };
}

/**
 * Delete a storage entry. Cookies are deleted by overwriting with an expired
 * value (the only JS-visible way); the read-back after deletion is the truth,
 * same as setStorage.
 */
export function delStorage(kind: StorageKind, key: string): { storage: StorageKind; key: string; deleted: boolean } {
  if (!key) {
    throw new Error('key is required');
  }
  if (kind === 'cookie') {
    document.cookie = `${key}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    return { storage: kind, key, deleted: parseCookies()[key] === undefined };
  }
  if (kind !== 'local' && kind !== 'session') {
    throw new Error(`unknown storage: ${kind}`);
  }
  const store = kind === 'local' ? window.localStorage : window.sessionStorage;
  store.removeItem(key);
  return { storage: kind, key, deleted: store.getItem(key) === null };
}

// ---------------------------------------------------------------------------
// page info
// ---------------------------------------------------------------------------

export function getPageInfo(): PageInfo {
  const nav: any = (typeof performance !== 'undefined' && performance.getEntriesByType) ?
    (performance.getEntriesByType('navigation') || [])[0] : undefined;

  let memory: PageInfo['memory'];
  const perfAny = <any>performance;
  if (perfAny && perfAny.memory) {
    memory = {
      usedJsHeapSize: perfAny.memory.usedJSHeapSize,
      totalJsHeapSize: perfAny.memory.totalJSHeapSize,
      jsHeapSizeLimit: perfAny.memory.jsHeapSizeLimit,
    };
  }

  let navigation: PageInfo['navigation'];
  if (nav) {
    navigation = {
      type: String(nav.type || ''),
      ttfbMs: nav.responseStart != null ? Math.round(nav.responseStart) : undefined,
      domContentLoadedMs: nav.domContentLoadedEventEnd != null ? Math.round(nav.domContentLoadedEventEnd) : undefined,
      loadMs: nav.loadEventEnd != null ? Math.round(nav.loadEventEnd) : undefined,
      transferSize: nav.transferSize,
    };
  }

  const conn: any = (typeof navigator !== 'undefined') ? (<any>navigator).connection : undefined;

  return {
    url: location.href,
    title: document.title || '',
    referrer: document.referrer || '',
    userAgent: navigator.userAgent,
    platform: navigator.platform || '',
    language: navigator.language || '',
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    },
    screen: {
      width: (screen && screen.width) || 0,
      height: (screen && screen.height) || 0,
    },
    visibility: (document.visibilityState as PageInfo['visibility']) || 'visible',
    online: navigator.onLine !== false,
    memory,
    navigation,
  };
}

// ---------------------------------------------------------------------------
// screenshot (html2canvas, best effort)
// ---------------------------------------------------------------------------

// Local-first: the hub serves a vendored html2canvas on the very port the probe
// connects to, so a page behind no CDN access at all can still be screenshotted.
// The CDNs stay behind it for setups where the server does not vendor the file
// (older server, path-prefixed endpoint, https page vs. http origin).
const HTML2CANVAS_CDNS = [
  'https://fastly.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
  'https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
];
const HTML2CANVAS_LOAD_TIMEOUT_MS = 10000;
const MAX_IMAGE_BASE64_CHARS = 2 * 1024 * 1024; // ~1.5MB binary
const MAX_CAPTURE_PIXELS = 3.5 * 1024 * 1024;

function loadScript(w: any, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let timer: ReturnType<typeof setTimeout>;
    const settle = (err?: Error) => {
      clearTimeout(timer);
      script.remove();
      if (err) { reject(err); } else { resolve(); }
    };
    // a hung download may never fire onerror — cap each source
    timer = setTimeout(() => settle(new Error(`timeout loading ${src}`)), HTML2CANVAS_LOAD_TIMEOUT_MS);
    script.onload = () => {
      if (typeof w.html2canvas === 'function') { settle(); }
      else { settle(new Error('html2canvas loaded but global is missing')); }
    };
    script.onerror = () => settle(new Error(`failed to load ${src}`));
    script.src = src;
    document.head.appendChild(script);
  });
}

async function loadHtml2Canvas(assetUrl?: string): Promise<any> {
  const w = <any>window;
  if (typeof w.html2canvas === 'function') {
    return w.html2canvas;
  }
  const sources = assetUrl ? [assetUrl, ...HTML2CANVAS_CDNS] : HTML2CANVAS_CDNS;
  let lastErr: unknown;
  for (const src of sources) {
    try {
      await loadScript(w, src);
      return w.html2canvas;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`failed to load html2canvas from all ${sources.length} sources: ${String((lastErr as Error)?.message || lastErr)}`);
}

export async function screenshot(args: { format?: 'png' | 'jpeg'; scale?: number; assetUrl?: string }): Promise<ScreenshotResult> {
  const html2canvas = await loadHtml2Canvas(args.assetUrl);

  const docEl = document.documentElement;
  const fullWidth = Math.max(docEl.scrollWidth, window.innerWidth);
  const fullHeight = Math.max(docEl.scrollHeight, window.innerHeight);
  const dpr = window.devicePixelRatio || 1;
  let scale = Math.min(args.scale || dpr, 2);
  // cap total pixels so long pages don't explode memory
  const pixels = fullWidth * fullHeight * scale * scale;
  if (pixels > MAX_CAPTURE_PIXELS) {
    scale = Math.max(0.5, Math.sqrt(MAX_CAPTURE_PIXELS / (fullWidth * fullHeight)));
  }

  const canvas = await html2canvas(document.body, {
    scale,
    useCORS: true,
    logging: false,
    backgroundColor: '#ffffff',
    windowWidth: fullWidth,
    windowHeight: fullHeight,
  });

  let format: 'png' | 'jpeg' = args.format === 'jpeg' ? 'jpeg' : 'png';
  let dataUrl = canvas.toDataURL(`image/${format}`, 0.8);
  if (format === 'png' && dataUrl.length > MAX_IMAGE_BASE64_CHARS) {
    // degrade to jpeg for size
    format = 'jpeg';
    dataUrl = canvas.toDataURL('image/jpeg', 0.75);
  }
  if (dataUrl.length > MAX_IMAGE_BASE64_CHARS) {
    throw new Error(`screenshot too large (${Math.round(dataUrl.length / 1024)}KB base64); page may be too long`);
  }

  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  return {
    format,
    width: canvas.width,
    height: canvas.height,
    dataBase64: base64,
  };
}
