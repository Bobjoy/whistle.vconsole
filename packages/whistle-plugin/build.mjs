#!/usr/bin/env node
/**
 * Pack @bobjoy/whistle.vconsole into an installable tgz.
 *
 * The MCP server lives in this package (src/*.ts -> dist/*.cjs via `npm run
 * bundle`), so the only runtime deps are the public ones (SDK/ws/zod). They are
 * vendored through bundleDependencies, which is what makes
 * `w2 install <tgz> --offline` work. The probe bundle is vendored as
 * dist/probe.js and served at /probe.js for the injection rule.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const root = path.dirname(url.fileURLToPath(import.meta.url));
const monorepo = path.resolve(root, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const RUNTIME_DEPS = ['@modelcontextprotocol/sdk', 'ws', 'zod'];

// 1. probe bundle -> dist/probe.js
const probeBundle = path.join(monorepo, 'packages/vconsole/dist/vconsole.min.js');
if (!fs.existsSync(probeBundle)) {
  throw new Error(
    `找不到探针产物 ${probeBundle}：packages/vconsole 是 git submodule，` +
    '先跑 git submodule update --init，再 pnpm --filter @bobjoy/vconsole build',
  );
}
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.copyFileSync(
  probeBundle,
  path.join(root, 'dist/probe.js'),
);

for (const file of ['index.cjs', 'cli.cjs', 'httpService.cjs']) {
  if (!fs.existsSync(path.join(root, 'dist', file))) {
    throw new Error(`dist/${file} 缺失，请先构建：pnpm --filter @bobjoy/whistle.vconsole build`);
  }
}
// the probe loads its screenshot helper from vendor/html2canvas.min.js (served
// on the hub port); shipping without it would silently fall back to the CDNs
for (const file of ['html2canvas.min.js']) {
  if (!fs.existsSync(path.join(root, 'vendor', file))) {
    throw new Error(`vendor/${file} 缺失`);
  }
}

// 2. assemble + install + pack
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vcm-plugin-'));
const packDir = path.join(work, 'package');
fs.mkdirSync(packDir, { recursive: true });
// devDependencies stay out of the manifest: nothing in there is needed at
// runtime (the protocol source is inlined into dist/*.cjs at build time)
const { devDependencies, ...publishPkg } = pkg;
fs.writeFileSync(path.join(packDir, 'package.json'), JSON.stringify({
  ...publishPkg,
  // npm pack excludes node_modules EXCEPT bundled deps — this is what makes the
  // tgz installable offline (w2 install runs npm install on it)
  bundleDependencies: RUNTIME_DEPS,
}, null, 2));
for (const entry of ['index.js', 'rules.txt', 'lib', 'dist', 'vendor']) {
  fs.cpSync(path.join(root, entry), path.join(packDir, entry), { recursive: true });
}

execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', { cwd: packDir, stdio: 'inherit' });

// Pack manually instead of `npm pack`: the package.json `files` allowlist makes
// libnpmpack drop node_modules even when bundleDependencies is set. A plain tar
// of the whole dir (npm pack uses the same `package/` layout) guarantees the
// vendored node_modules ships.
// The name keeps whistle's `whistle.` prefix so `w2 install` recognises it.
const shortName = pkg.name.replace(/^@[^/]+\//, '');
const outTgz = path.join(monorepo, `${shortName}-${pkg.version}.tgz`);
fs.rmSync(outTgz, { force: true });
execSync(`tar -czf ${JSON.stringify(outTgz)} -C ${JSON.stringify(work)} package`, { stdio: 'inherit' });
fs.rmSync(work, { recursive: true, force: true });

console.log(`built: ${outTgz}`);
