# ADR-003: 请求重放（replay）在页面侧执行，默认拦非幂等

日期：2026-10-05　状态：Accepted

## 背景

hub 的网络缓冲里，每条请求项（`NetworkItem`：`url` / `method` / `requestHeader` / `postData` / `getData`）已经带着重放所需的全部信息，缺的只是"谁把第二次请求发出去"。两条路：hub 用 Node 直接发（探针零改动），或下发一个命令让页面用自己的 `fetch` 重发。

## 决策

**由页面发。** 探针新增 `replay` 命令，读原请求项、用 `fetch` 原样再发一次，把新响应回给 hub。

三条理由，每一条都是 hub 侧发做不到的：

1. **登录态**：抓包得到的 `requestHeader` 永远不含 `Cookie`（浏览器不把它暴露给 JS），只有页面自己发才带得上。Node 侧发出去的是**另一个身份**的请求，测出来的 401/403 会被人误读成"接口挂了"。
2. **路径一致**：页面发的请求照旧经过 whistle 代理，插件规则、mock、改包都仍然生效；Node 直接发根本不过代理。
3. **可见性**：页面发的那一次会被探针自己的 fetch 代理截获，成为一条新网络项（带 `replayedFrom` 标记），人和 agent 都能在面板里看到它、再用 `get_network(requestId)` 取全量响应。Node 侧发的那次在系统里是隐形的。

## 由此确定的边界

- 语义只能是**近似重放**：`postData` 是 `genFormattedBody` 之后的格式化副本，`string` / 纯 kv 可按 `Content-Type` 重新编码，二进制体（Blob / File / ArrayBuffer）在抓包那一刻已塌成 `[object Blob]` 占位符——**遇到就直接报错不发**，绝不降级成"少个 body 照样发"。占位符检测放在**页面侧**：hub 里的 `postData` 是展示用序列化结果，批量推送时会被体积预算截成 `…[budget exceeded]`，据此判断会漏放（真机验证时踩到：一个带文件的上传被当成纯 kv 发了出去）。
- `Cookie` / `Origin` / `Host` / `Content-Length` 属 fetch 的 forbidden header，浏览器会静默忽略，不假装能覆盖。
- 跨域重放受目标 CORS 约束，读不到响应时明确回 `network-error`，与业务错误分开。
- **默认拦非幂等**（POST / PUT / PATCH / DELETE 需显式 `allowUnsafe: true`）——这是页面侧的必然推论：既然请求真会再打一次后端，重复下单、重复提交的后果就是真实的。

## 备选方案与否决理由

- **hub 侧 Node 重放**：实现最薄（不碰协议、不碰探针），但上面三条全丢。否决。
- **两侧都做，页面优先、页面断开时回落 hub**：覆盖看着全，实际是同一个工具两种可信度，agent 得先判断"这个响应带不带登录态"。否决。
- **为重放而给探针保留一份原始 body 副本**（拦截时 tee 流 / 异步读 Blob）：能真还原上传类接口，代价是每条请求双份内存 + 改 fetch/xhr 两条代理路径。不是 MVP 的量级，留待真有需求再议。
