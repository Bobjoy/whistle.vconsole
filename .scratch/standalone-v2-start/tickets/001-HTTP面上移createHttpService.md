# HTTP 面上移到 `src/httpService.ts`（预重构，行为零变化）

**Blocked by**: 无

## 目标
把 `lib/runtime.js` 里的整套 HTTP 面搬成一个可独立调用的 `createHttpService(...)`，插件改调它——从此 standalone 有了可复用的那一半，而 whistle 路径行为一字不变。

## 涉及层
- [ ] 逻辑层：新建 `packages/whistle-plugin/src/httpService.ts`，导出 `createHttpService(cfg) -> { server, port, stop() }`。搬运清单（现 `lib/runtime.js` 行号）：
  - `createSseHub` `:77-123`
  - `handleRequest` `:183-297`（token 网关 `:189-194` 保持调 `hasAccess`）
  - `buildInjectHtml` `:311-326`
  - `readBody` `:328-344`
  - `MCP_HTTP_PORT = 9527` `:20`、`PROBE_BUNDLE` `:21` —后者参数化：默认相对 `__dirname` 的 `dist/probe.js`，`cfg.probeBundlePath` 可覆盖（测试要用）
- [ ] 逻辑层：`lib/runtime.js` 收缩到只剩 whistle 特有的三样——`boot()` 的 `state.booted` 单例 `:49-69`、`alreadyServing()` + 10s 重试接管 `:34-47`、`start()` 里 `createBackend()` + `createHttpService()`。`index.js` 的 302 不动，pfork 自愈不下沉。
- [ ] 构建：在 `src/index.ts` re-export `createHttpService`（`lib/runtime.js` 只能从 `dist/index.cjs` 取符号；esbuild 入口无需加文件，跟着 `src/index.ts` 的依赖图走）。
- [ ] 测试：`test/http.e2e.mjs` 从 92 行起手写的那台 http server 换成 `createHttpService`——现有 47 项检查一项不减，从此同时是「插件与 standalone 同源」的证明。

## 验收标准
- `pnpm --filter @bobjoy/whistle.vconsole build` 绿（含 `tsc --noEmit`）
- `node packages/whistle-plugin/test/http.e2e.mjs` 全绿；`pnpm test:e2e` 全绿（148 项）
- 真链路：`w2 start` → `curl 127.0.0.1:9527/api/sessions` 200 且含 `"sessions"`；`/probe.js` 与 `packages/probe/dist/vconsole.min.js` md5 一致；面板 `/` 正常渲染
- `git diff --stat` 里 `lib/runtime.js` 只剩 boot/自愈/start 三块（净删行数为正）

## 备注
搬移必须逐字节等价（含 401 文案、`Cache-Control: no-store`、SSE `retry: 3000` 与 25s 心跳），这片唯一的产出就是「一样」。
