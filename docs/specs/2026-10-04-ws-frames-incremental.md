# Spec: `ws_frames` — WebSocket 帧增量查看（MCP 工具）

日期：2026-10-04　状态：Draft　实现接缝：hub 侧（探针零改动）

## 1. 问题陈述

WeChat / APP webview 场景里，推送与长连接调试是最大痛点。现状：

- 探针侧 `websocket.proxy.ts` 已经在截获 `ws.send()` / `onmessage`，累积在 `item.messages`（`requestType: 'websocket'` 的网络项里），经 `network.model.ts` 推给 hub。
- hub 侧 `get_network` 在 **list 模式**故意剥掉 `messages` 字段（避免撑爆 60k 文本上限），agent 只能拿 `requestId` 去 `get_network` detail 捞全量帧。
- `networkBuffer`（每 session 上限 500 个网络项）**混排所有类型**：WS 帧密集时，非 WS 项被挤掉、WS 项本身随 buffer 轮转也会消失。
- 没有"增量拉下一帧"的通道——agent 无法挂在一个长连接上**等推送帧到达**。

结果：agent 排查"这个 WS 推送为什么没到" / "服务端第 N 帧内容是什么" 时，要么靠截图肉眼、要么靠重新复现，效率低。

## 2. 方案概述

新增 MCP 工具 `ws_frames`：agent 传一个**时间戳游标**（`sinceFrameTime`），hub 从该 session 的帧级环形缓冲里返回**游标之后的最近 N 帧**；agent 循环调用即可持续增量消费，实现"等下一帧"。

**零探针改动**：帧截获链路不变，仅在 hub 侧 `Session` 加一个独立的帧级环形缓冲（容量 2000，FIFO），与既有 `networkBuffer` 分离。WS 帧多不会挤掉其它网络项。

## 3. 用户故事（可独立验证的行为清单）

- **US-1 增量拉取**：agent 首次调用 `ws_frames({})` 拿到最近 50 帧 + `nextSince`；再调用 `ws_frames({ sinceFrameTime: <上次的 nextSince> })` 只拿到新到的帧，不重复。
- **US-2 过滤到某条连接**：`ws_frames({ wsUrl: 'wss://a.com/push' })` 只返回该 url 的帧；跨连接默认按时间混排。
- **US-3 二进制帧保真**：探针推下来的 `ArrayBuffer` 帧（`data` 非 string），在 `ws_frames` 输出里是 **base64** 字符串，agent 能解回字节；不丢成 `[binary]` 占位符。
- **US-4 缓冲溢出可感知**：环形缓冲满 2000 从头部挤帧；agent 拿到 `oldestSeq`，若自己上次的 cursor 早于它，自知"中间有帧被挤掉"，可自行决定是否重新全量拉。
- **US-5 会话隔离**：`ws_frames({ sessionId })` 定向到某设备；不传用活跃会话（与其它 11 个工具的约定一致）。
- **US-6 离线 / 空态不报错**：会话离线或该 session 没有 WS 连接，返回 `{ frames: [], nextSince: 0, oldestSeq: 0 }`，不 throw。
- **US-7 文本结果可截断**：单条帧 `data` 巨大（如 10MB 推送 payload）时，走既有 `jsonResult` 的 60k 截断 + `…[truncated by whistle-vconsole]`，不 OOM。

## 4. 已定决策（避免翻案）

1. **场景**：WeChat/APP 专项（不是 PC 性能 / 多设备协同桶）。
2. **MVP 落点**：`ws_frames`，**不进面板**；面板 WS 帧视图留 2.x。
3. **实现位置**：hub 侧新工具，**探针零改动**（否决探针侧独立环形缓冲——要动协议双副本，MVP 不划算；否决扩 `get_network` 加 `type=ws`——list 行变胖、与既有"list 轻量"原则冲突）。
4. **契约**：
   ```
   ws_frames({ sessionId?, wsUrl?, sinceFrameTime?, limit=50 })
     → { frames: [{ wsUrl, seq, type: 'send'|'receive', data: string, time: number }],
         nextSince: number, oldestSeq: number }
   ```
   - `nextSince` = 返回批里最后一条帧的 `time`（ms）；agent 下次原样传回即增量。
   - **游标纯时间戳**，无复合 `seq` 游标（跨连接可比，心智简单）。
   - `seq` = hub 侧 per-connection（按 `wsUrl`）单调递增；探针不记录、hub 在 append 时补。
   - **不报 `dropped`**：靠 `oldestSeq` 让 agent 自己判断"中间漏了"。
5. **二进制帧兜底**：`data` 非 string → **base64**（保真），不是 `[binary]` 占位符。
6. **缓冲容量**：每 session 帧级环形缓冲 **2000**，FIFO，与 `networkBuffer`（500 网络项）分离。

## 5. 测试决策（接缝 + 完成态）

**接缝**（优先复用既有）：

- 探针侧：**不动**。`websocket.proxy.ts` / `network.model.ts` 的截获链路保持原样。
- hub 侧 `Session.addNetwork`：既有入口（探针对 WS 项推全量 `messages`，hub 在此展开进 `wsFrameBuffer`）。
- 测试接缝 = **e2e fake probe**（`test/e2e.mjs` 里现有的 fake 会话）：推一个 `requestType: 'websocket'` 网络项 + 增量 `messages`（send/receive 交替 + 一条 `ArrayBuffer` 帧），再调 `/mcp` 的 `ws_frames` 断言。

**断言点**（每条对应一个 US）：

- US-1：两次调用（带 cursor）返回帧集不重叠、时序正确。
- US-2：`wsUrl` 过滤只命中该连接。
- US-3：`ArrayBuffer` 帧的 `data` 是 base64（`Buffer.from(b64,'base64')` 能解回原字节）。
- US-4：推 2001+ 帧后 `oldestSeq > 0`，且被挤掉的前缀帧不再出现在返回里。
- US-5：两个 fake 会话各推不同 WS 帧，`sessionId` 定向互不串。
- US-6：离线会话 / 无 WS 会话返回空帧不报错。
- US-7：单条超大 `data` → `jsonResult` 截断标记出现。

**完成态**：`pnpm test:e2e` 全绿（现有 27+11+18 + 新增 ws_frames 断言）；`pnpm build` 绿；实机（whistle 插件重装后）对真页面跑一遍 `ws_frames` 无异常。

## 6. 明确不做（本次边界）

- **不做面板 WS 帧视图**（2.x；MVP 仅 MCP 工具）。
- **不动探针协议**（`packages/whistle-plugin/src/protocol.ts` 与 `packages/probe/src/mcp/protocol.ts` 双副本本次**不加**任何帧级消息类型）。
- **不实现复合 seq 游标**（游标纯时间戳；同毫秒两帧的极端竞态由 `oldestSeq` 兜底提示，不精确补偿）。
- **不实现帧持久化 / 历史回放**（环形缓冲 2000 帧上限，session 断开即丢）。
- **不实现按 `requestId` 精确订阅单连接**（US-2 用 `wsUrl` 文本匹配；精确订阅留 2.x）。
- **不实现帧级 mock / 注入**（只读查看，不发送、不改写——发送是 2.x 或独立工具）。

## 7. 补充说明

- ~~`data` 字段在协议里声明是 `string`；但探针侧 `websocket.proxy.ts` 的 `addMessage` 对 `ArrayBuffer`/`Blob` 是**原样 push**，只有文本帧才是 string。所以**二进制兜底必须在 hub 侧做**（探针不改）：hub 展开 `messages` 时，`typeof data !== 'string'` 就 base64 编码。~~ **（2026-10-05 更正：这条推演是错的，见文末「修订」——上报是 JSON，二进制到 hub 时已经变成 `{}`，hub 侧根本拿不到字节，兜底只能放在探针侧预编码。）**
- per-connection `seqCounter` 的 key 是 `wsUrl`：同一 url 断开重连视为**延续**同一连接的序号（推送调试里"这条 url 上第几帧"比"第几个连接"更有用）。
- `wsFrameBuffer` 的展开必须**按 item.id 记录已展开到第几帧**（hub 侧对同一 item 是全量替换 `existing.item = item`，探针推全量 `messages`）；否则会重复展开前缀。
- 工具结果 60k 截断是**既有行为**，`ws_frames` 不改变 `jsonResult` 逻辑。
- 老探针（未截获 WS）的 session 调 `ws_frames` 返回空帧，不报错（US-6）。

## 修订（2026-10-05）：二进制帧必须探针侧预编码

实现后实测：`messages` 是随网络项一起 **JSON** 上报的，`addMessage` 原样 push 的 `ArrayBuffer` / `TypedArray` / `DataView` / `Blob` 在离开页面那一刻就成了 `{}`（Blob 序列化即空对象），hub 侧的 `typeof data !== 'string'` 分支拿到的永远是空对象——**兜底放 hub 侧等于没有兜底**。US-3「二进制帧保真」因此改为在探针侧完成编码：

- **接缝移动**：新增探针侧接缝 `packages/probe/src/network/wsCodec.ts`（纯函数 `encodeWsData`，单测 `packages/whistle-plugin/test/ws-codec.unit.mjs` 直接 esbuild 打包它跑）；hub 侧 `Session.normalizeWsData` 只负责认标记、剥标记。
- **线上格式**：`WS_BINARY_MARKER + base64`，被 8192 字节上限截断时再追加 `:<原始字节数>`；hub 解码后 `frames[].data` 仍是「文本 or 纯 base64」，截断信息落在新增可选字段 `totalBytes`（US-7 的 60k 截断行为不变，但大帧不再被整条重推）。
- **US-3 断言改为**：fake 探针按真探针的线上格式发 `__vcb64__:<base64>`，`ws_frames` 返回的 `data` 必须等于纯 base64（`Buffer.from(b64,'base64')` 解回原字节），并另断言截断帧的 `totalBytes`。
- **§2 / §4.3 / §5 的「零探针改动」自本修订起作废**（仅指二进制路径；帧截获链路、`network.model.ts`、游标与 seq 语义都没动，协议也没有新增帧级消息类型——只是给 `NetworkWsMessage.data` 定了编码约定）。
- **Blob 异步**：`binaryType` 默认 `blob`，探针先落 `Blob(<size>)` 占位、读到后就地改写；hub 的 `expandWsFrames` 比对尾帧原始值，改写时**刷新已记录的帧**而不追加（e2e 里用同 id 网络项二次上报验证）。
