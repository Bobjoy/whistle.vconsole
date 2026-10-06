# ADR-006: 探针源码外置到 fork 仓库（git submodule），fork 用 dev 镜像 + mcp 分支

日期：2026-10-06　状态：Accepted

## 背景

探针一直以目录的形式住在本仓库里（`packages/probe`），与 upstream 的关系只写在 `package.json` 的描述里，没有任何 git 关系——本仓库只有 1 个 squash 基线 commit（`4b02050`），探针改动对 upstream 没有可追溯的历史，也就没法 rebase upstream 的修复。

迁移动因是一次实测：把本地探针树与 `Bobjoy/vConsole`（`Tencent/vConsole` 的 fork，默认分支 `dev`）按 blob sha 逐个比对，结果是 **124 个文件字节一致、9 改、5 增**（`src/mcp/{bridge,commands,serialize,wsClient}.ts` + `src/network/wsCodec.ts`）——我们与 upstream 的偏离比预想的小得多。同时发现一个真问题：`packages/probe/.gitignore` 第 2 行的 `lib` 是**我们自己加的**（upstream 只有 `dist`/`typings`），它顺手把 `src/lib/` 下 7 个 upstream 源文件排除在 git 之外（磁盘上有、`git ls-files` 里 0 个）。也就是说本仓库提交的探针**单独 clone 出来构建不起来**，而 webpack 之所以一直没报错，只是因为这些文件恰好还在工作区里。

> **搬迁前复测（同日，对 fork `dev` HEAD `de7026d`，含未提交的脏工作区）**：**13 改 + 6 增**——多出来的是网络重放 ticket 动的 `src/network/fetch.proxy.ts`、`src/network/requestItem.ts` 与新文件 `src/mcp/replayStamp.ts`，以及协议内联动了的 `tsconfig.json`、`tsconfig.type.json`、`webpack.config.js`；`webpack.serve.config.js` 复测为与 fork 相同。逐条清单以 `docs/specs/2026-10-06-package-topology-probe-fork.md` US-2 为准。
>
> **`.gitignore` 落地修正（搬迁时实测）**：修法不是「在 fork 里把 `lib` 改成 `/lib`」——fork `dev` 从来没有这条规则，7 个 `src/lib/*` 已经在 git 里且 blob 与本仓库一致；这条洞只存在于我们复制出来的那份 `.gitignore`。所以真正的动作是**搬迁时不带 `lib` 这一行**。

## 决策

**探针的唯一源码地是 `Bobjoy/vConsole`，本仓库以 git submodule 挂在 `packages/vconsole`（URL 走公开 https）。**

- **fork 双分支**：`dev` 只做 upstream 镜像（只允许 fast-forward），我们的全部偏离（复测口径 13 改 + 6 增，清单见 spec US-2）落在 `mcp` 分支，submodule pin `mcp`。同步 upstream = fetch `dev` + rebase `mcp`，冲突永远只出现在 `mcp` 分支上，镜像分支保持干净。
- **发版从 fork 做**：`@bobjoy/vconsole` 的 `package.json`、CHANGELOG、构建配置都属于 fork。
- **探针侧单测跟着探针走**：`ws-codec.unit.mjs`（10 项）、`screenshot-loader.unit.mjs`（9 项）、`replay.unit.mjs`（21 项）搬进 fork，fork 自带工具链（esbuild 作 devDependency；三件是手写 `check()` 计数，**不是** `node:test` 文件，搬过去零改写，由一条 `npm test` 串起来）。本仓库的 `pnpm test:e2e` 从 233 项降到 193 项，只剩服务面的接缝。
- **fork 不自带协议依赖**：`@bobjoy/vconsole-protocol` 不发包、也不跨仓库引用，协议在 fork 里是一份独立副本 `src/mcp/protocol.ts`（理由与护栏见 ADR-0007）。

## 后果

- 本仓库 `git clone` 必须 `--recursive`；`pnpm build` 前必须 `git submodule update --init`。submodule 未 init 时构建与测试要**显式报错并指路**，不允许报成"找不到模块"。
- 改探针要进 submodule 提交，父仓库多一个 gitlink diff；`.gitignore` 里我们自己加的 `lib` 那一行不能跟着搬，否则同样的洞会跟着搬过去。
- 探针回归不再被本仓库那条 `pnpm test:e2e` 覆盖，两道测试要在文档里写清各在哪跑。

## 被否决的方案

- **MCP bridge 留本仓库、构建期拼接 upstream**：upstream 绝对纯净，但一条 webpack 链吃两处源码，类型与 protocol 引用都要绕，且这次暴露出的 `.gitignore` 洞正是这种"两边都不管"的产物。
- **只重命名目录、不做 submodule**：零新增复杂度，但放弃 upstream rebase 能力，且 fork 仓库（`Bobjoy/vConsole`）成了空壳。
- **改动直接进 `dev`**：单分支最直觉，但镜像一旦被污染，"对 upstream 做 diff"就得先减掉 merge。
- **fork 就此定基线、不再同步 upstream**：零同步成本，但 vConsole 后续的修复全得自己挨，与选 fork 这个动作的初衷相反。
