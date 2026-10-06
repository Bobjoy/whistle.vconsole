# 本仓库换成 submodule：删 `packages/probe`、立 gitlink、切清净所有硬编码路径

**Blocked by**: 001, 002, 003, 004（硬约束：fork 侧必须完整且能构建能测试，才准删本仓库副本）

## 目标
`packages/probe` 变成一个 gitlink（`packages/vconsole` → fork 的 `mcp` 分支），本仓库不再有探针源码目录；两条起服务路径拿到的 `probe.js` 仍然是同一个文件。

## 前置：需要用户授权
`git submodule add` 走的是**远端 URL**，所以 `mcp` 分支必须先 push 到 `github.com/Bobjoy/vConsole`。这是第一次往共享远端写东西 —— **动手前必须拿到用户明确授权**，不得从「继续」推断。

## 涉及层
- [ ] git：`git rm -r --cached packages/probe` + 移除工作目录（先确认 002/003/004 的 fork 提交在位、fork 内 `npm run build` 与 `npm test` 双绿；`dist/`、`node_modules/`、被忽略的 `src/lib`、`build/protocol-ambient.d.ts` 随目录一起消失即可，不进 git）
- [ ] git：`git submodule add -b mcp https://github.com/Bobjoy/vConsole.git packages/vconsole` → 产出 `.gitmodules`（URL 用公开 https，不用 ssh；`branch = mcp`）；`git ls-files -s packages/vconsole` 必须是 `160000 <sha> 0`
- [ ] 逻辑层：改两处构建期路径（全仓实测只有这两条硬编码，其余全是文档）
  - `packages/whistle-plugin/build.mjs:27` —`path.join(monorepo, 'packages/probe/dist/vconsole.min.js')` → `packages/vconsole/dist/vconsole.min.js`
  - `examples/demo-h5/server.mjs:19` —默认 `--probe-dist` 同上
- [ ] 依赖：`pnpm install` 重生成 `pnpm-lock.yaml`（现状 `importer packages/probe` 与 vite 的 `'@bobjoy/vconsole': link:../probe` 要变成 `packages/vconsole` / `link:../vconsole`）。`pnpm-workspace.yaml` 的 `packages/*` 天然覆盖 submodule 目录，不需要加条目；`packages/vite-plugin/package.json` 的 `workspace:*` 也不动（实测：caret 范围才会掉 registry，`workspace:*` 直接链）。
- [ ] 文档：`README.md`（第 21 行的协议描述、目录结构图）、`CONTEXT.md` 里凡是 `packages/probe` 的措辞改指 submodule；`docs/`、`.scratch/` 里的历史记录**不回改**（它们是当时事实）。

## 验收标准
- `git ls-files -s packages/vconsole` 输出 `160000 <sha> 0`；`cat .gitmodules` 含 `path = packages/vconsole`、`url = https://github.com/Bobjoy/vConsole.git`、`branch = mcp`
- `grep -rn "packages/probe" --exclude-dir=node_modules --exclude-dir=.scratch --exclude-dir=docs .` 0 命中（`pnpm-lock.yaml` 里旧 importer 也必须消失）
- `pnpm build` 全绿；`node packages/whistle-plugin/build.mjs` 后 `dist/probe.js` 存在
- 真链路：`v2 start` → `curl -s 127.0.0.1:9527/probe.js | md5` == `packages/vconsole/dist/vconsole.min.js` 的 md5
- `examples`：`pnpm demo` 起得来，`/vconsole.min.js` 200 且 md5 同上

## 备注
`packages/vconsole/dist/` 不进 git（fork 自己 ignore），所以 `git clone --recursive` 之后必须先 `pnpm build` 才谈得上服务 —— 这正是 ticket 007 那条守卫存在的理由。
