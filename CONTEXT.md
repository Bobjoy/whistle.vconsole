# CONTEXT.md — whistle-vconsole 领域术语表

> 纯术语表，不放实现细节。术语一旦在此敲定，代码 / 注释 / 文档统一用这套词。

## 角色与端点

| 术语 | 定义 |
|------|------|
| **probe（探针）** | 跑在 H5 页面里、负责截获日志 / 网络 / WebSocket 帧并推给 hub 的 JS 端（`packages/probe`，构建产物 `probe.js`） |
| **hub** | 跑在 whistle 插件进程里、监听 9528（WS）/ 9527（HTTP+MCP）的 Node 端（`packages/whistle-plugin`） |
| **session** | hub 侧一个设备 / 页面的连接态，id = 设备指纹 `dev-<fnv1a32>` |
| **agent** | 通过 MCP 调 hub 的 AI / CLI 调用方 |
| **hub 资源口** | 9528 端口在 WS 之外兼作的只读静态 GET（目前只有 `/html2canvas.min.js`，插件 `vendor/` 里的文件）。探针按自己连的 `serverUrl` 做 `ws→http` 同源替换得到它，所以换端口、纯内网都不用改配置 |

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
