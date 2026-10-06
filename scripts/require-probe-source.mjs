// packages/vconsole is a git submodule; an empty one is not a workspace member,
// so `pnpm --filter @bobjoy/vconsole build` would match nothing and exit 0.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

if (!fs.existsSync(path.join(root, 'packages/vconsole/src/vconsole.ts'))) {
  console.error('packages/vconsole 里没有探针源码：它是 git submodule，请先跑 git submodule update --init');
  process.exit(1);
}
