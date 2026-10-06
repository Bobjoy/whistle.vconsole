# Spec: `replay_request` — Network 请求原样重放（MCP 工具 + 面板按钮）

日期：2026-10-05　状态：Draft　实现接缝：协议 + 探针命令 + hub 工具面 + 面板详情区（一条垂直切片）

## 1. 问题陈述

面板 Network 与 `get_network` 能让 agent / 人**看到**页面发过什么请求，但看不到"这个接口现在还是不是这样"。要复现一次，今天的做法是回页面点一下触发它的那个按钮——可很多请求是启动时一次性发出的（配置拉取、埋点、上传失败），点不出来；或者是偶发的，复现不了。

已确认的现状（不缺数据，缺执行）：

- `bridge.ts:364 toNetworkItem()` 上传的 `NetworkItem` 已带 `url / method / requestHeader / postData / getData / responseHeader`，hub 侧 `get_network({ requestId })` 能取到完整一条。
- 命令通道现成：`hub.sendCommand(cmd, args, timeoutMs, sessionId)`，`CmdType` 七个值（`eval`/`get_dom`/`get_storage`/`set_storage`/`del_storage`/`page_info`/`screenshot`）。
- 探针的 `fetch` / `xhr` 代理本来就在截获每一次请求，重放发出去的那一次会被自动记成一条**新**网络项。

## 2. 方案概述

新增第 13 个 MCP 工具 `replay_request`：agent（或面板上的人）拿一个 `requestId`，hub 把这条历史记录下发给页面，页面用自己的 `fetch` **原样**再发一次，把新响应回给调用方。

页面侧执行是这一版的承重决策（理由与备选否决见 `docs/adr/0003-page-side-replay.md`）：浏览器会自动带上 `Cookie` / referer / 同源上下文，请求照旧经过 whistle 代理，且这一次会作为新网络项被记录，人和 agent 都看得见。

语义边界：**原样重发**，不含参数覆盖（那是"构造请求"，另一件事）；请求体用的是抓包时的**格式化副本**，能重新编码的就发，二进制体已塌成占位符的就明确拒绝。

## 3. 用户故事（每条可独立验证）

- **US-1 基本重放**：agent 调 `replay_request({ requestId })` 重放一条已完成的历史 GET，拿到 `{ status, statusText, responseHeader, body, costTime, responseSize, replayedId }`，`status` 是**这一次**的真实状态码，不是历史记录里的旧值。
- **US-2 登录态在场**：重放一条需要 cookie 的接口，返回的不是 401/403——因为请求由页面自己发出，浏览器自动带上 cookie（抓包里的 `requestHeader` 本来就没有 `Cookie`，这条只能在页面侧成立）。
- **US-3 结果可追全量**：`body` 只回前 8KB，并带 `truncated: true` 与原始大小；调用方拿 `replayedId` 再调 `get_network({ requestId: replayedId })` 能取到完整响应。
- **US-4 非幂等默认被拦**：重放一条 POST 时不带 `allowUnsafe`，**请求不会发出**，返回的错误里说明这是非幂等方法、要重放需显式传 `allowUnsafe: true`；带上之后能正常发出并拿到新响应。
- **US-5 只放 xhr / fetch**：对 `requestType` 为 `websocket` 或静态资源（`img`/`css`/`js`/`font`）的 `requestId` 发起重放，返回明确拒绝并说明该类型不可重放，不发出请求。
- **US-6 不可还原的请求体不假装**：原请求体是 FormData 里的文件或 Blob（抓包时已塌成 `[object Blob]` 这类占位符）时，返回错误说明"请求体在抓包时已被格式化，无法原样重放"，**不发**；反之 `string` 或纯 kv 形态的 body 会按原 `Content-Type` 重新编码后发出。
- **US-7 重放来源可辨**：重放产生的新网络项带 `replayedFrom = <原请求 id>`，`get_network` 的 list 与 detail 都能看到该字段；面板 Network 详情里同样显示"重放自 …"。
- **US-8 面板一键重放**：面板 Network 详情区有「重放」按钮，点击后展开区显示新响应（状态码、大小、耗时、body 摘要）；对非幂等方法，按钮先要求一次确认，确认后才发。
- **US-9 记录不过代理的坑不存在**：重放那一次经 whistle 代理，插件规则（注入 / mock / 改包）对它的效果与页面自己发的请求完全一致。
- **US-10 离线与失效可诊断**：会话已断开时返回命令超时的既有错误；`requestId` 已被 500 条 FIFO 缓冲挤掉时，返回与 `get_network` 同一句 `request not found: … (buffers may have been evicted; re-list with get_network)`。
- **US-11 跨域失败分开报**：重放一个被 CORS 挡住的跨域请求时，返回 `network-error`（说明是 CORS 或断网导致读不到响应），不会静默当成空响应或业务错误。
- **US-12 会话定向**：`replay_request({ sessionId, requestId })` 打到指定设备；不传 `sessionId` 用活跃会话——与其它 12 个工具一致。
- **US-13 forbidden header 不假装**：历史记录里带 `Cookie` / `Host` / `Origin` / `Content-Length` 之类字段时（例如人工构造的数据），重放会跳过它们且不报错，因为浏览器本来就会忽略——不承诺重放能覆盖这些头。

## 4. 已定决策（避免翻案）

1. **能力边界**：原样重发，无 `url` / `headers` / `body` 覆盖参数。
2. **执行位置**：页面侧 `fetch`（ADR-003）。
3. **非幂等闸**：默认只放 `GET` / `HEAD` / `OPTIONS`；`POST` / `PUT` / `PATCH` / `DELETE` 必须显式 `allowUnsafe: true`；面板按钮对非幂等叠一次二次确认。
4. **请求体**：`string` / 纯 kv 按 `Content-Type` 重编码；检测到 `[object Blob]` / `[object File]` / `[object ArrayBuffer]` 类占位符直接拒绝，不降级发送。
5. **调用面**：MCP 工具 `replay_request` 与面板按钮**都做**，共用同一 `/api/tool` 入口（`del_storage` 只上面板的先例在这里不适用）。
6. **返回形态**：摘要 + 截断 body（8KB，带 `truncated` / `responseSize`）+ `replayedId`，走 `CmdResultMsg` 回传。
7. **可重放类型**：只 `xhr` + `fetch`。
8. **来源标记**：协议 `NetworkItem` 加可选 `replayedFrom?: string`。
9. **测试接缝**：假探针 e2e 覆盖 hub 侧闸与契约 + browser-use 驱动 demo 页手验一次页面侧真发。

我替你拍的三条（都刻意不新增配置旋钮）：

- **超时**沿用 `sendCommand` 现有的 30s（与 `eval_js` 一致）。hub 侧超时后探针**不**主动 abort 那次 fetch：请求会跑完并被记录成新网络项，"结果丢了但记录还在"当特性用，用 `replayedId`/`get_network` 事后取。
- **重复调用不去重**：同一个 `requestId` 调两次就发两次（与浏览器行为一致）；风险由第 3 条的 `allowUnsafe` 拦在外面。
- **`requestId` 失效语义**直接复用 `get_network` 既有那句错误文案，不新造第二种"找不到"的表述。

## 5. 测试决策

主接缝是**已有的假探针**：`packages/whistle-plugin/test/e2e.mjs` 里的 Node WS 客户端本来就按 `msg.cmd` 分发并回 `CmdResultMsg`，重放的命令分发、闸门、返回契约、`replayedFrom` 透传全部可在这里断言，且不需要真浏览器（US-1/3/4/5/6/7/8后端侧/10/12/13）。HTTP 面在 `http.e2e.mjs` 补一条走 `/api/tool` 的等价调用。

页面侧真发这一段（占位符检测、body 重编码、cookie 在场、CORS 错误分类）用 browser-use 驱动 `pnpm demo` 的 9443 页面**手工跑一次**：一条成功的 GET 重放 + 一条被拦的 POST + 一条 FormData 上传被拒。沿用 html2canvas 那轮的验证纪律（先比 md5 确认装机字节，再看 `performance` 里的请求）。

"完成"= 回归从 105 涨到 ≥115 且全绿，`pnpm build` 绿，真浏览器手验三项各出一张证据。

## 6. 明确不做

- 参数覆盖 / 请求构造器（改 url、改 header、改 body 再发）。
- 为保真而让探针留存原始 body 副本（tee 流、异步读 Blob）——ADR-003 已记否决理由。
- hub 侧 Node 重放、页面断开时回落 hub。
- websocket 帧的"重发一帧"、静态资源行的重放。
- 批量重放 / 场景录制回放（一次一条，串起来由 agent 自己做）。
- 任何鉴权与配置项（LAN-only 边界不变，见 ADR-002）。

## 7. 补充说明

- 实现落点：`packages/protocol/src/protocol.ts`（`CmdType` 加 `'replay'`、`ToolApiName` 加 `'replay_request'`、`NetworkItem.replayedFrom?`）→ `packages/probe/src/mcp/commands.ts`（重放本体）+ `bridge.ts` 分发 → `packages/probe/src/network/fetch.proxy.ts`（盖章）→ `packages/whistle-plugin/src/tools.ts`（闸门与分发）+ `src/mcpServer.ts`（第 13 个工具 schema）→ `lib/panel.js`（详情区按钮 + 二次确认）→ README 工具数 12→13。
- **盖章机制**要一点小心思：重放那次 fetch 由代理自动截获，代理得知道"这是重放"。做法是探针模块内一个同步可读的一次性标记，重放代码在调用 `fetch` **之前**设置、代理在同一个 tick 内同步读到并盖到那条 item 上、随即清空。JS 单线程保证不会被别的请求误吃；不要用"按 url 匹配"那种会在同 URL 重复调用时错标的办法。
- `HEAD` / `OPTIONS` 归入幂等白名单，但静态资源类型已经先被 US-5 拒掉，实际很少走到。
- 术语以 `CONTEXT.md`「请求重放（replay）」一节为准：重放 / 原请求 / 格式化副本。
