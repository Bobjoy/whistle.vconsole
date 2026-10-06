# fork 自带探针侧单测：三件 `.unit.mjs` 搬过去并跑绿

**Blocked by**: 003

## 目标
把 `packages/whistle-plugin/test/` 里那三件**测探针源码**的单测搬到 fork，`npm test` 一条命令跑出 40 项全绿——探针的测试从此跟着探针走，本仓库不再替 fork 保管它的靶心。

## 涉及层
- [ ] 文件：搬 `ws-codec.unit.mjs`（10 项）、`screenshot-loader.unit.mjs`（9 项）、`replay.unit.mjs`（21 项）到 fork 的 `test/` 下，**手写的 `check()` 计数结构原样保留**（不改成 `node:test`，搬移零改写是这片的原则）。
- [ ] 逻辑层：源码定位改成本仓库相对路径——`ws-codec.unit.mjs:36` 的 `new URL('../../probe/src/network/wsCodec.ts', import.meta.url)` → `../src/network/wsCodec.ts`；`replay.unit.mjs:35` 的 `probeSrc` helper 同理（`../../probe/src/${rel}` → `../src/${rel}`）。文件头注释里的 `packages/probe/...` 路径同步改。
- [ ] 依赖：fork 的 `devDependencies` 加 `esbuild`（今天这三件用的是插件包的 `esbuild: ^0.28.2`，探针包自身没有）；`package.json` 加 `"test": "node --test test/"` 还是逐文件 `node test/*.unit.mjs`——**按现状选后者**：这三件不是 `node:test` 测试文件，用 `node test/ws-codec.unit.mjs && node test/screenshot-loader.unit.mjs && node test/replay.unit.mjs` 串起来，不为了好看引入新机制。
- [ ] 测试：三件在 fork 内跑通；产物退出码为 0（现在的 `check()` 结构失败时会 `process.exitCode = 1`，保留）。

## 验收标准
- fork 里 `npm install && npm test` → 输出 `ws codec: 10 passed, 0 failed`、`screenshot loader: 9 passed, 0 failed`、`replay unit: 21 passed, 0 failed`，退出码 0
- 三件文件的项数与搬迁前**逐项相等**（40 项，不多不少）；`git log -p` 里这三件的 diff 只有路径常量和头注释，没有断言增删
- fork 里 `grep -rn "packages/probe\|\.\./\.\./probe" test/` 0 命中
- 若 `esbuild` 打包时报 `@bobjoy/vconsole-protocol` 无法解析：给 `build()` 加 `alias`。**实测（2026-10-06）**：`src/network/wsCodec.ts:11` 确实是**值导入**（`WS_BINARY_MARKER`、`WS_BINARY_MAX_BYTES`），不是 type-only——但三件测试在 fork 里不加 alias 也全绿，因为 esbuild 会从被导入文件所在目录向上自动发现 `tsconfig.json`，命中 `paths` 里的 `"@bobjoy/vconsole-protocol": ["src/mcp/protocol.ts"]`。本仓库过去能过也是同一机制（`packages/probe/tsconfig.json` 指 `../protocol`）。记录在案：以后若有人给这三件显式传 `tsconfig: false` 或挪动 tsconfig 位置，就得补 alias。

## 备注
本票完成后，本仓库 `packages/whistle-plugin/test/` 里这三个文件仍在（删是本仓库侧的事，见 ticket 010），两边各跑一次全绿才允许删。
