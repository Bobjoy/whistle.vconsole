# 规格：探针外置为 fork submodule + 包拓扑收敛 + 协议版本软校验

日期：2026-10-06　来源：本轮 grill 共识（`docs/adr/0006`、`docs/adr/0007`、`docs/adr/0008`）　术语：`CONTEXT.md`「包拓扑」「协议版本兼容」

## 1. 问题陈述

探针（probe）一直以目录形式住在本仓库，与 upstream 没有任何 git 关系：本仓库只有 1 个 squash 基线 commit，探针改动对 `Tencent/vConsole` 不可追溯，也就没法 rebase upstream 的修复。实测比对（按 blob sha 逐个比）显示我们与 `Bobjoy/vConsole` 的 `dev` 只差 **9 个修改 + 5 个新增**（搬迁前对含脏工作区的当前磁盘状态复测，已增至 13 改 + 6 增，逐条见 US-2），本来是最容易保持同步的形态。

同时暴露出一个已存在的完整性缺陷：`packages/probe/.gitignore` 第 2 行的 `lib` 是我们自己加的（upstream 只有 `dist`/`typings`），它把 `src/lib/` 下 7 个 upstream 源文件排除在 git 之外——磁盘上有、`git ls-files` 里 0 个。**本仓库提交的探针单独 clone 出来构建不起来**，此前 webpack 一直没报错只因为这些文件恰好还留在工作区。

另一头，"拆成 `vconsole`(探针) / `cli`(服务) / `mcp` / `whistle-plugin` 四个包"的重规划提案经核查站不住：whistle 对插件包名有硬门，MCP 拆成独立进程会掉两条现成能力。拓扑要收敛，但方向不是拆得更细。

## 2. 方案概述

```
Bobjoy/vConsole (fork, 独立仓库)          whistle.vconsole (本仓库)
  dev   = upstream 镜像，只 fast-forward    packages/vconsole     → submodule，pin mcp 分支
  mcp   = 我们的 9+5 改动 + 协议副本         packages/whistle-plugin → 一个包全部服务：hub+HTTP面+面板+MCP+bin v2+whistle 注入，
     + 探针侧 3 个单测 + 修好的 .gitignore      Node 侧那份协议就是它的 src/protocol.ts（ADR-0007 修订）
                                           packages/vite-plugin   → 保留发包
```

三件事：① 探针源码与它的单测整体搬到 fork 的 `mcp` 分支，本仓库只留 submodule 引用；② 服务与 whistle 接入继续同一个发布物，不拆 `cli`/`mcp`/面板包；③ 协议不发包，两侧各持一份内联副本，改用 `PROTOCOL_VERSION` 握手做**软校验**（不匹配只标警告）作为漂移的唯一报警口。

## 3. 用户故事

**A. fork 仓库侧（`Bobjoy/vConsole` 的 `mcp` 分支）**

- US-1 `dev` 分支与 upstream `Tencent/vConsole` 的 `dev` 保持可 fast-forward（`git merge-base --is-ancestor` 成立），没有任何我们的提交落在上面。
- US-2 `mcp` 分支相对 `dev` 的差异恰好是搬迁前复测出来的 **13 个修改 + 6 个新增**（旧快照的 9+5 已被脏工作区超过：replay ticket 动了 `src/network/fetch.proxy.ts`、`src/network/requestItem.ts`，协议内联动了 `tsconfig.json`、`tsconfig.type.json`、`webpack.config.js`，replay 还带来新文件 `src/mcp/replayStamp.ts`）。
  - 修改：`.gitignore`、`package.json`、`tsconfig.json`、`tsconfig.type.json`、`webpack.config.js`、`build/build.typings.js`、`src/vconsole.ts`、`src/core/core.ts`、`src/core/options.interface.ts`、`src/log/log.model.ts`、`src/network/websocket.proxy.ts`、`src/network/fetch.proxy.ts`、`src/network/requestItem.ts`
  - 新增：`src/mcp/{bridge,commands,serialize,wsClient,replayStamp}.ts`、`src/network/wsCodec.ts`
  - 注：`webpack.serve.config.js` 复测为**与 fork 相同**（旧 9 人名单里把它算进去了），加上本轮新放的协议副本与探针单测。
- US-3 `package.json` 的 `name` 是 `@bobjoy/vconsole`、`version` 是 `3.16.0`，`repository` 指向 fork。
- US-4 `.gitignore` 用 `/lib`（根锚定）而不是 `lib`，`git ls-files src/lib | wc -l` = 7。
- US-5 单独 `git clone` fork 的 `mcp` 分支 → `npm install && npm run build` 出 `dist/vconsole.min.js` 与 `dist/vconsole.min.d.ts`，全过程不引用任何父仓库路径。
- US-6 探针侧协议 import 走本地副本：`src/mcp/protocol.ts` 存在，`tsconfig.json:16` 的 `paths`、`webpack.config.js:68` 的 `resolve.alias['@bobjoy/vconsole-protocol']` 都指向它（不再指 `../protocol/...`），`build/build.typings.js:16` 也从它生成 ambient 块。
- US-7 fork 里一条 `npm test` 跑探针侧三件测试（`ws-codec` 10 + `screenshot-loader` 9 + `replay` 21 = 40 项）全绿，退出码 0。

**B. 本仓库侧引用与守卫**

- US-8 `packages/vconsole` 是 gitlink（`git ls-files -s packages/vconsole` 输出 `160000 <sha> 0`），`.gitmodules` 里 URL 用公开 https、`branch = mcp`。
- US-9 `git clone --recursive` 后 `pnpm install && pnpm build` 全绿（`packages/vconsole` 作为 workspace 成员被 pnpm 正常解析）。
- US-10 未 `submodule update --init` 时跑 `pnpm build`：**立刻失败并打印要跑 `git submodule update --init`**，而不是报 "Cannot find module"／"ENOENT dist/vconsole.min.js" 之类需要读者自己反推的错。
- US-11 本仓库不再存在 `packages/probe` 这个路径（含 `pnpm-lock.yaml`、README、docs、tickets 之外的所有硬编码引用）。
- US-12 插件构建产物仍对齐：`:9527/probe.js` 的 md5 == `packages/vconsole/dist/vconsole.min.js`（插件路径与 standalone 路径各验一次）。
- US-13 `examples/demo-h5/server.mjs` 与 `examples/demo-h5/cdn.html` 指向新路径/新包名，demo 页照常起。

**C. 协议双副本与软校验**

- US-14 协议不出现在任何包的 `dependencies` 里；发布链只有 3 个包（`@bobjoy/vconsole`、`@bobjoy/whistle.vconsole`、`@bobjoy/vconsole-vite`），互不阻塞。**修订（2026-10-07）**：原本靠"`@bobjoy/vconsole-protocol` 保持 `private: true`"达成，现在那个壳撤了——Node 侧那份折进 `packages/whistle-plugin/src/protocol.ts`，比"私有包"更直接地不可能被当成依赖（见 ADR-0007 修订）。
- US-15 Node 侧机制不变：`packages/whistle-plugin/tsconfig.json` 的 `paths` 仍直指 `../protocol/src/protocol.ts`，构建期内联，发布物里不存在该包。
- US-16 两份副本初始状态一致（同一份协议内容、同一个 `PROTOCOL_VERSION`）。
- US-17 hub 读 `connect` 上报的 `protocol`：与自身 `PROTOCOL_VERSION` 一致时 session 上没有任何 mismatch 痕迹；不一致时**连接保持**，`list_sessions` 返回该 session 带 `protocolMismatch: <探针上报值>`。
- US-18 面板设备卡片上能看到这条 mismatch（不弹全局警告、不打断使用）。
- US-19 假探针（现有 e2e 里那个）能只改上报版本号就触发 US-17 的断言，不需要真浏览器。

**D. 远端与公开前清扫**

- US-20 本仓库有 GitHub 公开远端，`git push` 后 `git status` 干净；各包 `package.json` 的 `repository` 指向它（URL 由用户提供，缺它则 US-20 视为未完成）。
- US-21 全仓（含 fork 那份副本）不再有形如 `192.168.<a>.<b>` 的局域网 IP 字面量，一律写成 `192.168.x.x` 占位；实现时实测点位：`packages/protocol/src/protocol.ts`（Node 那份副本同处）、`packages/vite-plugin/README.md`、fork 的 `src/core/options.interface.ts`。
- US-22 `.zcode/config.json` 不再以绝对路径+用户名的形式被 README 引用：加进 `.gitignore`，README 改成给一份可粘贴的 JSON 片段（路径写作 `<workspace>/…`、命令写作 `node`）。
- US-23 解包扫描（`npm pack` 后解 tgz 看内容，不是看源码）里没有本机绝对路径（形如 `/Users/<用户名>`）、真实 IP、token。

## 4. 已定决策（不再翻）

| 决策 | 出处 |
|------|------|
| 探针唯一源码地 = fork；本仓库 submodule 引用 | ADR-0006 |
| fork `dev` 只做 upstream 镜像，改动在 `mcp` 分支，submodule pin `mcp` | ADR-0006 |
| 探针侧单测跟探针进 fork，fork 自带 Node 测试工具链 | ADR-0006 |
| 服务与 whistle 接入**不拆包**，包名沿用 `@bobjoy/whistle.vconsole`，目录名沿用 `packages/whistle-plugin` | ADR-0007 |
| MCP 不另起进程：`/mcp` 与 stdio 同一进程；面板留在服务包 | ADR-0007 |
| 插件继续自包含 bundle，`w2 install <tgz> --offline` 能力不丢 | ADR-0007 |
| 协议**不发包、不跨仓库引用**，两侧各一份内联副本（翻案 v2.1 的单一来源收敛） | ADR-0007 |
| 协议版本只做软校验，不匹配不断开 | ADR-0008 |
| 带着 ticket 001–009 的脏工作区一起迁移，不先提交基线 | 本轮用户选择 |

## 5. 测试决策（接缝）

**复用现有接缝，不新增接缝**：

1. **CLI 进程边界**（`packages/whistle-plugin/test/cli.e2e.mjs`，82 项）——standalone 与插件共存、`v2` 各子命令的行为在此验；US-12 的 md5 对齐在这验。
2. **`createHttpService`**（`test/http.e2e.mjs`，47 项）——HTTP 面全部行为在此验；**US-17/US-19 的协议软校验加在这里**：现有假探针只需把上报 `protocol` 改成 `PROTOCOL_VERSION + 1`，断言连接仍在、`list_sessions` 带 `protocolMismatch`。
3. **stdio e2e**（`test/e2e.mjs` 50 项）+ **multi-session**（11 项）+ 协议编解码单测（`ws-codec` 10 项搬去 fork）——工具面与多设备行为。
4. fork 侧新增接缝 = **在 fork 里直接跑探针源码的三件单测**（`npm test` 串三条 `node test/*.unit.mjs`——它们是手写 `check()` 计数，不是 `node:test` 文件；靶心与 esbuild 现包现跑的机制原样搬，不改写）。

`本仓库 pnpm test:e2e` 的项数从 **233 → 193**（009 加过 3 项协议检查，故不是 230；搬走 `ws-codec` 10 + `screenshot-loader` 9 + `replay.unit` 21 = 40）。根 `package.json` 的 `test:e2e` 脚本同步删这三条。**注意 `packages/whistle-plugin` 的 `esbuild` devDependency 要留着**——`package.json:29/31` 的 `bundle`/`dev` 脚本直接调它的 CLI，删了构建当场断。

**"完成"的定义**：fork 内 `npm run build` 绿 + `npm test` 40 项绿；本仓库 `pnpm build` 绿 + `pnpm test:e2e` 193 项 0 FAIL；真链路两条各跑一遍——`v2 start`（daemon）与 `w2 install`+`w2 start`（插件，注意插件进程懒 fork，要摸一次 `/plugin.vconsole/` 才起端口）；US-10 的守卫手工验一次（临时 `mv` 走 submodule 目录再跑 `pnpm build`，看完报错文案就 `mv` 回来）。

## 6. 明确不做

- **协议副本一致性校验脚本/测试**：不加。本轮我提过"几行比对两份副本导出名集合 + `PROTOCOL_VERSION`"，用户未采纳也未否决，按最小范围处理——漂移由人工同轮改两处 + ADR-0008 软校验承担。以后要加是独立小改动。
- **`@bobjoy/vconsole-protocol` 发包**、**Node 侧跨仓库 alias 直指 fork 源码**：两条都被否（见 ADR-0007）。
- **拆 `packages/cli` / `packages/mcp` / 面板独立包**：否。
- **CI / GitHub Actions / 发布自动化**：本轮不碰；远端只为 `repository` 字段与源码可见性。
- **真机（手机走 LAN 代理）复验**：不属本次变更范围，仍是独立待办。
- **给 fork 加 lint/format/测试以外的工程化设施**（changeset、tag 规范、upstream 同步自动化）：不做，同步靠手工 fetch + rebase。
- **改 `v2` 命令面、端口模型、token 模型、注入规则**：全部不动（ADR-002/004/005 维持）。

## 7. 补充说明（执行时要带着的事实）

- **迁移顺序上有一条硬约束**：`packages/probe` 里的内容（含 ticket 001–009 未提交的改动：`src/mcp/bridge.ts`、`commands.ts`、`replayStamp.ts`、`network/fetch.proxy.ts`、`requestItem.ts`）**必须先完整落到 fork 仓库并确认能构建，才允许在本仓库删除**。工作区是脏的，删早了没有回退点。
- 探针与 fork 的真实偏离清单（**2026-10-06 对 fork `dev` HEAD `de7026d` 复测**，含脏工作区）：修改 13 个、新增 6 个（逐条见 US-2）；另有 32 个 fork 独有文件本地没有，其中 7 个正是被 `.gitignore` 的 `lib` 排除的 `src/lib/*`（内容与 fork 逐 blob 相同，我们从没改过它们，ticket 001 要捡回来），`package-lock.json`、`CLAUDE.md`、`dev/lib/{demo.css,weui.min.css}` 属刻意不要。
- 探针侧要动的引用点是 **4 处**（不是先前记的 3 处）：`tsconfig.json:16`（`paths`）、`webpack.config.js:68`（alias）、`build/build.typings.js:16`（读源码生成 ambient）、`.gitignore:4`（注释里点名 `../protocol`）。
- 本仓库硬编码 `packages/probe` 的位置只有两处（其余全是文档）：`packages/whistle-plugin/build.mjs:27`、`examples/demo-h5/server.mjs:19`；另有 `packages/whistle-plugin/test/{ws-codec,screenshot-loader,replay}.unit.mjs` 里的 `../../probe/src/...` 相对路径三条——它们随 ticket 010 整体删除，不做过渡性改写。
- pnpm 事实（实测，非文档推断）：pnpm 9.9.0 不把 caret 范围（`^0.4.0`）链到同名 workspace 包，会直接去 registry 取并 404；只有 `link-workspace-packages=true` 才 `link:../a`。本轮选了双副本，因此**不需要**这个开关。
- 本机默认 registry 是 `registry.npmmirror.com`（镜像有同步延迟）。发布链上任何"装自己刚发的版本"必须显式 `--registry=https://registry.npmjs.org/`。
- 发版顺序（互不阻塞，但有先后）：`@bobjoy/vconsole`（在 fork 发）→ `@bobjoy/whistle.vconsole` → `@bobjoy/vconsole-vite`；每次 `pnpm publish` 带 `--no-git-checks`，需要 OTP，且要用户明确授权。
- 还挂着的旧待办：`packages/whistle-plugin/README.md`（npm 落地页）要不要补——本轮没讨论。
