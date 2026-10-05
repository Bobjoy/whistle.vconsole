/**
 * Vendored browser-side assets, served on the hub's own port.
 *
 * The probe only ever promises to reach `serverUrl`, so answering plain GETs
 * there is the one local source that works for every deployment (whistle
 * plugin, standalone CLI) and for pages that can reach neither the dev
 * machine's other ports nor the public CDNs.
 */

import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';

/** html2canvas 1.4.1 (MIT), from the npm tarball — sha256 e87e5507…eab8cb */
const VENDOR: Record<string, { file: string; contentType: string }> = {
  '/html2canvas.min.js': {
    file: path.join(__dirname, '..', 'vendor', 'html2canvas.min.js'),
    contentType: 'application/javascript; charset=utf-8',
  },
};

/** frozen files, so one read per process is enough */
const cache = new Map<string, Buffer>();

/** @returns true when the request has been answered here */
export function serveVendoredAsset(url: string, res: ServerResponse): boolean {
  const hit = VENDOR[url.split('?')[0]];
  if (!hit) { return false; }
  let body = cache.get(hit.file);
  if (!body) {
    try {
      body = fs.readFileSync(hit.file);
      cache.set(hit.file, body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`vendored asset missing: ${path.basename(hit.file)}`);
      return true;
    }
  }
  res.writeHead(200, {
    'Content-Type': hit.contentType,
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(body);
  return true;
}
