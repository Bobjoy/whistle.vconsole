# ADR-001: WS 帧增量查看走 hub 侧新工具，帧级独立环形缓冲 + base64 二进制兜底

日期：2026-10-04　状态：Accepted

## 背景

WeChat/APP 场景里推送 / 长连接调试是最大痛点：现有 `get_network` 把 WS 项的 `messages` 字段在 list 模式**故意剥掉**（避免撑爆 60k 文本上限），agent 只能拿 `requestId` 去 `get_network` detail 里捞全量帧，且 `networkBuffer`（上限 500 个网络项）混排了所有类型——WS 连接多 / 帧密集时，非 WS 项会被挤掉、WS 项本身也会随 buffer 轮转消失。没有"增量拉下一帧"的便捷通道，agent 无法挂在一个长连接上等推送。

## 决策

新增 MCP 工具 `ws_frames`，**零探针改动**：

```
ws_frames({ sessionId?, wsUrl?, sinceFrameTime?, limit=50 })
  → { frames: [{ wsUrl, seq, type, data, time }], nextSince, oldestSeq }
```

1. **实现位置 = hub 侧**。帧已被探针 `websocket.proxy.ts` 截获、经 `network.model.ts` 推 hub；hub 在 `Session.updateNetworkItem` 里对 `requestType === 'websocket'` 的项把 `messages` 展开进一个**新的帧级环形缓冲**（容量 2000，FIFO），与 `networkBuffer` 分离。
2. **游标 = 时间戳**（`nextSince` = 最后一条帧的 `time`，ms），不按帧级 seq 做复合游标——agent 心智是"等下一帧"，时间戳够用且跨连接可比。
3. **seq = hub 侧 per-connection 单调递增**，探针不记录、hub 补。
4. **二进制帧兜底 = base64**（非 `[binary]` 占位符）：WeChat/APP 推送里二进制帧（压缩 / 协议帧）常是关键数据，占位符会让 agent 拿到"已丢失"。
5. **不报 `dropped`**：环形缓冲头部帧的 `seq` 即 `oldestSeq`，cursor 早于它 agent 自己判"中间漏了"。
6. **MVP 不进面板**，只做 MCP 工具；面板 WS 帧视图 2.x。

## 备选与否决理由

- **扩 `get_network` 加 `type=ws` + list 行保留 `messages`**：list 行变胖、与"list 保持轻量"的既有原则（HANDOFF 第六轮 Network 瘦身）冲突，且语义混淆（一个 list 工具混入帧级增量）。否决。
- **探针侧独立环形缓冲**：要动探针协议双副本（`packages/whistle-plugin/src/protocol.ts` + `packages/probe/src/mcp/protocol.ts` 同步加帧级消息类型），改动面大、MVP 不划算。否决（留 2.x 再议）。
- **`dropped` 精确计数**：环形挤帧只能给下界，精确值需额外簿记；`oldestSeq` 已足够让 agent 判断。否决。

## 影响

- 新增：`Session` 一个 `wsFrameBuffer` + `updateNetworkItem` 里的展开逻辑 + `tools.ts` 一个 case + `mcpServer.ts` 一个工具注册。**探针零改动**。
- 内存：每 session 最多 2000 帧环形缓冲，WS 密集场景可控；与 networkBuffer 分离，不影响既有 500 网络项上限。
- 兼容性：`ws_frames` 对老探针（无 WS 截获）返回空 frames，不报错。

## 修订（2026-10-05）：二进制帧改由探针预编码

原「零探针改动」在二进制帧上不成立，本 ADR 更正如下（决策 2、3、5、6 不变）：

1. **决策 1 的「零探针改动」作废**：上报走 JSON，`messages[].data` 里的 ArrayBuffer / TypedArray / DataView / Blob 序列化后变成 `{}`，hub 侧无论怎么兜底都拿不到字节。现在由**探针侧预编码**：`packages/probe/src/network/wsCodec.ts` 把二进制帧写成 `WS_BINARY_MARKER + base64`（标记与上限常量放在协议单一来源 `packages/protocol/src/protocol.ts`，不再有双副本），hub 的 `Session.normalizeWsData` 认这个标记并剥掉它，对外的 `data` 依旧「要么文本、要么纯 base64」。
2. **决策 4 补上限**：探针只编码前 `WS_BINARY_MAX_BYTES = 8192` 字节；被截断时在线上追加 `:<原始字节数>`（base64 字母表里没有 `:`，切分歧义为零），hub 剥标记后把它填进帧的可选字段 `totalBytes`，agent 由此知道"这只是前 8KB"。不设上限会让一条大帧被反复重推（探针每次更新都带全量 `messages`）。
3. **Blob 是异步的**：`WebSocket.binaryType` 默认 `blob`，收到的二进制帧大多是 Blob。探针先落 `Blob(<size>)` 占位，读到字节后就地改写这条 message 并触发一次更新；hub 按 `expandedUpTo` 只摊增量尾部，因此 `expandWsFrames` 会比对已记录的尾帧，发现被改写就**刷新原帧**（不追加重复帧）。
