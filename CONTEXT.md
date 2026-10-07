# CONTEXT.md — whistle-vconsole 领域术语表

> 纯术语表，不放实现细节。术语一旦在此敲定，代码 / 注释 / 文档统一用这套词。

## 角色与端点

| 术语 | 定义 |
|------|------|
| **probe（探针）** | 跑在 H5 页面里、负责截获日志 / 网络 / WebSocket 帧并推给 hub 的 JS 端。源码不在本仓库：住在 fork 仓库 `Bobjoy/vConsole`（upstream = `Tencent/vConsole`，默认分支 `dev`），本仓库以 git submodule 挂在 `packages/vconsole`，npm 包名 `@bobjoy/vconsole`，构建产物 `probe.js` |
| **hub** | 监听 9528（WS）/ 9527（HTTP+MCP）的 Node 端（`packages/whistle-plugin`，npm 包 `@bobjoy/whistle.vconsole`），带起方式见「启动形态」 |
| **session** | hub 侧一个设备 / 页面的连接态，id = 设备指纹 `dev-<fnv1a32>` |
| **agent** | 通过 MCP 调 hub 的 AI / CLI 调用方 |
| **hub 资源口** | 9528 端口在 WS 之外兼作的只读静态 GET（目前只有 `/html2canvas.min.js`，插件 `vendor/` 里的文件）。探针按自己连的 `serverUrl` 做 `ws→http` 同源替换得到它，所以换端口、纯内网都不用改配置 |

## 包拓扑（3 个发布物 + 1 个 submodule）

全部 `@bobjoy` scope，bin 只有一个：`v2`。**服务和 whistle 接入不出两个包**——whistle 只认包名匹配 `^(@scope/)?whistle\.[a-z\d_-]+`（`w2 install` 硬门），拆出去就没法既当 CLI 又当插件，所以 `@bobjoy/whistle.vconsole` 一个包同时是服务 + 插件，两种装法共用一份代码。

| 包 | 目录 | 负责 | 依赖 |
|----|------|------|------|
| **@bobjoy/vconsole** | `packages/vconsole`（**git submodule** → `Bobjoy/vConsole`） | 探针本体 + `src/mcp/*` 桥。fork 是探针的唯一源码地，发版从 fork 做 | 无跨仓库协议依赖（自带 `src/mcp/protocol.ts` 副本） |
| **协议（两份副本）** | Node 侧 `packages/whistle-plugin/src/protocol.ts`；探针侧 fork 的 `src/mcp/protocol.ts` | 跨端消息协议（类型 + 运行时常量/纯函数）。构建期内联进各自 bundle，发布物里不存在；**不发包、也不跨仓库引用**，所以它不再有包名 |
| **@bobjoy/whistle.vconsole** | `packages/whistle-plugin` | **一个包全部服务**：hub（WS 9528）+ HTTP 面 9527（面板、`/api/tool`、`/api/sessions`、`/api/events` SSE、`/probe.js`、`/inject.html`、`/mcp`）+ daemon（`v2 start/stop/status/logs`）+ 设备面板 UI + MCP 层（tools 定义与 McpServer 工厂）+ whistle 接入（`rules.txt` 注入、插件入口、菜单 redirect）。保持自包含 bundle（`bundleDependencies`），`w2 install <tgz> --offline` 仍能装 | 无跨仓库协议依赖（用 `packages/protocol` 那份内联）；构建期取 @bobjoy/vconsole 的 `dist/vconsole.min.js` |
| **@bobjoy/vconsole-vite** | `packages/vite-plugin` | vite dev 期注入探针 | @bobjoy/vconsole |

- **MCP 不另起进程**：`/mcp` 与 stdio 入口都在同一个进程里，保住「agent 配一条 http URL」和「裸跑 stdio 自带 hub」两条现有能力。
- **面板归服务侧**：设备列表 + 调试抽屉跟服务在同一个包，插件路径和 standalone 路径共用同一份 UI，不允许各存一份。
- **fork 分支线**：`Bobjoy/vConsole` 的 `dev` 只做 upstream（`Tencent/vConsole`）镜像（只 fast-forward），我们的改动在 `mcp` 分支；submodule pin `mcp`，同步 upstream = fetch dev + rebase `mcp`。
- **协议双副本**：探针搬进独立仓库后，协议**不发包、也不跨仓库引用**，两侧各持一份、各自构建期内联（Node 侧 `packages/whistle-plugin/src/protocol.ts`，探针侧 fork `src/mcp/protocol.ts`）。代价是它会漂，因此两条护栏：改协议必须同一轮动两处；`PROTOCOL_VERSION` 是唯一握手号（见「协议版本兼容」）。

## 启动形态

| 术语 | 定义 |
|------|------|
| **插件内起（in-plugin）** | whistle 的 `uiServer` 触发：hub + HTTP 面跟着 `w2` 起停，被代理页面靠 `rules.txt` 零改动注入探针 |
| **standalone** | 不依赖 whistle 起同一套（hub + 面板 + MCP-over-HTTP + `/probe.js`），由 `v2 start` 提供；页面接入只能自己引探针外链，没有自动注入 |
| **daemon（后台服务）** | `v2 start` 落的 detached 进程，pid 与日志都在 `~/.whistle-vconsole/`（和 `hub.json` 同目录）。`stop` 只杀自己记的那个 pid，绝不按端口反查杀别人 |
| **`v2` 命令** | 本包的唯一 bin 名（不带别名；`wv` 会撞 git worktree 的习惯用法）。子命令 `start`（默认后台，`-f` 前台）/ `stop` / `status` / `logs`；裸跑 `v2` = stdio MCP server（给 agent 进程用）。与探针包 `@bobjoy/vconsole`（跑在页面里的那个库）不是同一个东西 |
| **单 owner** | 9527 与 9528 一样只容一个进程做 owner：`v2 start` 撞上已在服务的插件就报错退出，不接管、不换端口 |
| **两条安装路径** | `w2 install`（whistle 插件：有自动注入、不生成全局命令）与 `npm i -g`（有 `v2` 命令、无注入）各装一份代码，互不取代。同一个包，谁在服务 + 版本是否一致由 `v2 status` 报 |

## WS 帧相关

| 术语 | 定义 |
|------|------|
| **WS 连接（wsUrl）** | 一条 `requestType === 'websocket'` 的网络项，由 `WebSocket` 实例的 url 标识 |
| **WS 帧（frame）** | 一次 `ws.send()` 或 `onmessage`，有方向（send/receive）和时间戳（ms） |
| **帧序号（seq）** | hub 侧 per-connection 单调递增的帧序，探针不记录、由 hub 在 append 时补 |
| **帧级缓冲（frame buffer）** | hub 侧独立环形缓冲（容量 2000），与 networkBuffer 分离，WS 帧多不挤掉其它网络项 |
| **游标（cursor / sinceFrameTime）** | 上次 `ws_frames` 返回的 `nextSince`，ms 时间戳，agent 下次传回做增量 |
| **oldestSeq** | 环形缓冲头部帧的 seq，cursor 早于它说明中间有帧被挤掉（agent 自己判） |
| **二进制帧兜底** | 二进制帧（ArrayBuffer/TypedArray/Blob）由**探针**预编码成 `WS_BINARY_MARKER + base64`（超 `WS_BINARY_MAX_BYTES=8192` 截断并附原始字节数），hub 认标记后剥掉——对外 `data` 依旧「要么文本、要么纯 base64」，不丢成 `[binary]` 占位符 |

## 网络项分桶（沿用既有）

`networkBucket(requestType)` → `css / js / img / xhr / ws / other`；WS 落 `ws` 桶。

## 协议版本兼容

| 术语 | 定义 |
|------|------|
| **协议版本（PROTOCOL_VERSION）** | 两份协议副本里那个唯一的整数握手号（当前 `1`），探针在 `connect` 消息里上报；两边不再同批发包，所以天然会不同版本 |
| **软校验（mismatch 只警告）** | hub 发现探针上报的版本 ≠ 自己那份时**不断开**，只在该 session 上标 `protocolMismatch`，面板设备卡片与 `list_sessions` 都能看到。理由：公网旧探针（CDN 固定版本）连本机新 hub 是主用例，硬断开等于堵死它 |

## 请求重放（replay）

| 术语 | 定义 |
|------|------|
| **重放（replay）** | 拿 hub 缓冲里某条网络项记到的字段（method / url / requestHeader / postData），**原样**再发一次并回新响应。刻意不含参数覆盖：要改参数是"构造请求"，不是"重放" |
| **原请求（source request）** | 被重放的那条历史记录，由 `requestId`（= 网络项 `id`）标识 |
| **格式化副本** | `postData` / `response` 是 `genFormattedBody` + `serializeOne` 之后的形态，**不是字节原文**：`string` 或纯 kv 对象可还原，二进制体（Blob / File / ArrayBuffer）在抓包时就塌成了 `[object Blob]` 这类占位符，永远拿不回来 |
