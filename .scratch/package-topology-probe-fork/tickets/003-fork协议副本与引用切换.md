# fork 自给自足：协议本地副本 + 切断对父仓库的每一条引用

**Blocked by**: 002

## 目标
fork 里放一份独立协议副本 `src/mcp/protocol.ts`，把探针侧所有指向 `../protocol/...` 的解析全部改到它，从此 `git clone` fork 单独构建就能出可用的探针产物——这是「探针外置」真正成立的那一刻。

## 涉及层
- [ ] 文件：新增 `src/mcp/protocol.ts` = 本仓库 `packages/protocol/src/protocol.ts` 的**当前磁盘内容**（含未提交改动），文件头注释改为说明「这是探针侧副本，Node 侧那份在 whistle-vconsole 仓库，改协议必须同轮动两处」并保留 `export const PROTOCOL_VERSION = 1`。
- [ ] 逻辑层：改 **4 处**解析点（spec §7 记的「3 处」少算了一条，本票按实测）：
  - `tsconfig.json:16` —`"@bobjoy/vconsole-protocol": ["../protocol/src/protocol.ts"]` → `["src/mcp/protocol.ts"]`
  - `webpack.config.js:68` —`Path.resolve(__dirname, '../protocol/src/protocol.ts')` → `Path.resolve(__dirname, 'src/mcp/protocol.ts')`，:65 的注释同步改写（不再是 workspace package，是本地副本）
  - `build/build.typings.js:16` —`path.resolve(__dirname, '../../protocol/src/protocol.ts')` → `path.resolve(__dirname, '../src/mcp/protocol.ts')`，:6 的注释同步
  - `.gitignore:4` 的注释 `# generated from ../protocol/src/protocol.ts by build/build.typings.js` → 指新副本路径（忽略项本身不动）
- [ ] 逻辑层：探针代码里的 `from '@bobjoy/vconsole-protocol'` **保持不变**（`src/mcp/bridge.ts:24-25`、`src/mcp/commands.ts:7`、`src/vconsole.ts:25`）——由 alias 落到本地副本，不做逐行改 import 的大扫除。
- [ ] 测试：全仓 grep 断言不存在任何 `../protocol` / `../../protocol` 字面量。

## 验收标准
- 在 fork 里 `npm run build && npm run build:typings` 出 `dist/vconsole.min.js` + `dist/vconsole.min.d.ts`（`build:typings` 是独立脚本，`pnpm build` 从来不含它，维持现状不加旋钮）
- `dist/vconsole.min.d.ts` 里含同名 ambient module 块（`declare module '@bobjoy/vconsole-protocol'`），且 `PROTOCOL_VERSION`、`VConsoleMcpOptions` 都在
- 把整个 fork 目录 `cp -R` 到一个隔离目录（**父目录里没有任何别的仓库**）后重复上一条 → 证明不依赖兄弟路径
- `grep -rn "\.\./protocol" <fork>` 0 命中
- ~~产物与本仓库当前 `packages/probe/dist/vconsole.min.js` md5 一致~~ **实测不成立，且不是搬迁引入的**（2026-10-06）：fork `d361cb65…` 338006 B vs 本仓库 `1073d9b5…` 327056 B。逐层查出来的原因有两条，都与代码语义无关：
  1. **两份 lockfile 解析出的依赖版本不同**——同一个 `^` 范围，本仓库 pnpm workspace lock 给 svelte 5.57.1 / webpack 5.111.1 / terser 5.6.1 / core-js 3.50.0 / css-loader 7.1.5，fork 里 upstream 的 `package-lock.json` 给 5.53.10 / 5.105.4 / 5.4.0 / 3.48.0 / 7.1.4。把这五个版本在本仓库对齐后，fork 产物从 338006 B 降到 **327059 B**，与本仓库只差 3 字节。
  2. **node_modules 布局不同改变 webpack 确定性模块 id**——剩余差异从产物第 996 字节开始，就是模块 id 表（同一个模块 `2482:` vs `9089:`）：本仓库是 `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>` 的路径，fork 是扁平 `node_modules/<pkg>`，`deterministic` id 由模块路径哈希而来。3 字节的总长差就是若干 id 的位数不同。
  改用的验收：同一棵源码树在**任何不含兄弟仓库的隔离目录**里构建，产物 md5 必须与该 checkout 相同（已实测：`/tmp` 隔离副本 `npm ci && npm run build` = `d361cb65…`，与本 checkout 一致）；跨安装形态不比 md5，只比源码 blob（002 已逐 blob 证明相等）。

## 备注
副本会漂这件事是**主动接下的税**（ADR-0007），唯一的报警口是 ticket 008/009 的软校验，不在本票加一致性脚本（spec §6 明确不做）。
