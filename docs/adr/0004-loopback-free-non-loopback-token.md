# ADR-004: 回环免鉴权、非回环需 `?t=` token（探针上公网后的接入边界）

日期：2026-10-06　状态：Accepted

## 背景

`@bobjoy/vconsole`（探针）和 `@bobjoy/whistle.vconsole`（hub + MCP）都要发到公网 npm。发包本身不漏任何东西——探针是纯客户端，包里没有地址也没有凭据；而且这份 bundle 本来就是公开的，任何连上的设备都会从 `:9527/probe.js` 下载同一个文件。

变的是"没人知道这套协议"这层遮挡没了。hub 侧的事实是：默认绑 `0.0.0.0`（`src/index.ts`），`new WebSocketServer({ server })` 不校验 Origin（`src/hub.ts`），token 链路在早前一轮被整条删除。也就是说**能路由到 9527/9528 = 能注册成设备、能读某台手机的全部日志与网络、能在它的页面里 `eval_js`**。公网 https 页面连 `ws://` 会被浏览器当混合内容拦掉，但同网段的任意网页、任意主机不需要任何前提。

## 决策

**一条规则：回环免鉴权，非回环必须带 `?t=<token>`。** 实现在 `hub.ts` 的 `hasAccess(rawUrl, remoteAddress, token)`，两个入口共用：

- WS 升级（探针接入）：不匹配就 `close(4001)`，不建 session；
- `:9527` 的数据端点（`/mcp`、`/api/tool`、`/api/sessions`、`/api/events`）：不匹配直接 401。

token 由 hub 启动时生成（`--token` / `WHISTLE_VCONSOLE_TOKEN` 可覆盖），写进 `~/.whistle-vconsole/hub.json`，并在 stderr 打印成可直接粘贴的 `ws://<lan>:9528?t=...`。注入路径对人零打扰：`/inject.html` 由 hub 生成，token 直接拼在 `serverUrl` 上；探针的 `wsClient` 本来就用 `?`/`&` 判断追加 `sid`，所以**探针零改动**。面板从自己的 URL 里取 token 透传给 `/api/*` 和可粘贴的 MCP 配置，本机（走 whistle 的 302 到 127.0.0.1）永远不需要它。

## 这条防住谁、不防住谁

防住的是**读不到我们 HTTP 响应的对端**——典型是别的机器上的网页或脚本：它能猜着发起 `ws://192.168.x.x:9528`（WebSocket 不受 CORS 约束），但拿不到 token，因此接不上。

不防的是**能直接 curl 我们端口的主机**：`/probe.js`、`/inject.html`、面板 HTML 必须是公开可取的（手机要通过代理拿到它们，注入片段里就带着 token），所以一台能自由读我们 HTTP 响应的机器能把 token 抄走。这不是漏洞而是既有边界：**同网段视为可信**这条从来没变（ADR-002、README 网络边界），本 ADR 只补上"公网可下载的协议 + 无鉴权"叠出来的那一层。要把同网段也变成不可信，需要的是 per-connection 授权与 TLS，量级远超这一步，且要先解决 ADR-002 里搁置的 relay 问题。

## 备选方案与否决理由

- **完全不鉴权，只写文档警告**：探针一旦公开，警告就从"提醒"变成"唯一防线"，而这条线是网络可达性本身。否决。
- **给所有入口都强制 token（含回环）**：MCP 客户端配置、whistle 的 302 面板跳转、`hub.json` 里已经存了端口的本机进程间共享，全都要跟着带 token；开发机自己的日常链路平白多一步复制粘贴。收益为零——本机进程本来就能读你的文件。否决。
- **校验 Origin / 用签名握手**：探针不是浏览器同源模型，手机 webview 的 Origin 可伪造，等于没防。否决。
- **默认绑 `127.0.0.1`**：手机连不上，直接打断"装完就能用"的主流程。否决。
