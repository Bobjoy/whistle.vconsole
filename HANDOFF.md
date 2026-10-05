# whistle-vconsole — 交接文档

更新：2026-10-05（**第二十七轮（发布前自查批，详单见第五轮开头那段第二十七轮改动清单）**：协议抽回 `packages/protocol` 单源（删双副本）→ 二进制 WS 帧改探针预编码 base64（含 `WS_BINARY_MAX_BYTES` 截断与 Blob 异步改写）→ `realDevice.isTablet` 修 iPad 桌面模式 → 面板卡片去重逻辑抽纯函数 + 单测 → **html2canvas vendor 进插件 + hub 端口兼作资源口 + 探针本地优先加载（纯内网可截图）** → 发布前置（demo 页去真 IP、三包 `publishConfig` 钉 npmjs、解包扫描四项待拍板见第八节）→ 文档（ADR-002 端口边界与 relay 搁置、README 网络边界、CONTEXT 术语）。**本轮修掉一个真缺陷**：`bridge.ts` 算了 `this.assetUrl` 却没传给 `screenshot()`，本地优先链在真页面静默失效（照旧走 CDN），单测只 bundle `commands.ts` 看不见接线所以是绿的——补传参 + 两条源码级接线断言，真浏览器复验 `performance` 里只剩 `http://localhost:9528/html2canvas.min.js`。另记两条环境坑：残留 pfork 进程会让 `:9527/probe.js` 一直吐旧字节（坑 20 复现），demo 服务器启动时快照探针文件（改探针必须重启 9443）。回归 74 → **105 全绿**（10+9+37+11+38），`pnpm build` 绿，装机与真浏览器双侧字节 md5 对齐。）。**第二十六轮：标签去掉 PC/Browser 徽标**（用户：「去掉 pc browser，已经可以从系统得知这些」）——括号只留系统段看不出来的信息：App/微信外壳、以及 Edge 这类**产品名**；桌面 Chrome → `Windows 10+ · Chrome 150`，移动独立浏览器 → `Pixel 9 · Android 15 · Chrome 150`，Edge 去掉 `PC|Mobile` 前缀 → `Chrome 154（Edge 154.0.0.0）`（顺序坑：先清空泛分类再让 edge 覆盖，反了会把 Edge 名擦掉）。**17 台主流设备模拟连接复验**（`/tmp/simulate-devices.mjs`，进程外假探针连 9528）：标签全表实测通过，微信/webview/Electron 容器与 Edge 产品名保留括号，其余裸内核；遗留两项——① iPad 桌面模式 UA 与 Mac 完全同形，纯 UA 无解，需 `maxTouchPoints`/Client Hints 加 `isTablet`；② 国产浏览器产品名被内核 Chrome 吞掉——**同轮已修**：Edge 特判泛化为产品 token 表（SamsungBrowser/MiuiBrowser/MQQBrowser/QQBrowser/UCBrowser/HuaweiBrowser/HeyTapBrowser/VivoBrowser/OppoBrowser/Quark/baidubrowser + `Edg*`→显示 `Edge`），Chrome 内核套壳显示 `Chrome 150（SamsungBrowser 29.0）`，无产品 token（真 Chrome/Safari/Firefox）保持裸内核；**只在 `container` 是 PC/Browser 时生效**，写在外层会把 App/微信容器名一起擦掉（第一版就踩了这个）。实测：`SM-S938B · Android 15 · Chrome 150（SamsungBrowser 29.0）` / `PGU110 · Chrome 144（UCBrowser 16.5.6.1310）` / 华为两台 `…（HuaweiBrowser 17.0.8.310）`。**面板卡片去重（同轮）**：`.dev` 与 `.muted` 两处都写浏览器名会重复，`lib/panel.js` 的 `renderSessions` 改为——有 `deviceName` 时把 `deviceLabel` 尾部全角括号段剥掉、只把**版本号**搬到 muted 里跟着 deviceName 显示（`SM-S938B · Android 15 · Chrome 150` + `(Galaxy S25 · Samsung Internet 29.0)`）；无 deviceName 时括号原样留在 `.dev`（产品名不能丢）。剥括号用 `lastIndexOf('（') + 末尾字符判断`，**不用正则**——面板 HTML 是模板字符串，正则里的 `\\d` 会被模板吃掉（第十三轮那个坑）。副作用：deviceName 措辞本身带系统名时会读成「HarmonyOS 17.0.8.310」（版本其实属于 HuaweiBrowser），真机 deviceName 一般是 `机型 · Android 13` 不受影响。17 台真面板 DOM 实测全对。**浏览器版本只留主版本（同轮，含一次修正）**：产品 token 的版本先裁成 `split('.')[0]`（`（Edge 154.0.0.0）`→`154`），副作用是 `MQQBrowser 14.3`/`UCBrowser 16.5` 的次版本本来就是营销版本，被误裁；最终规则 = **主版本 + 次版本非 0 才带**（`seg[1] !== '0'`）→ `Edge 154`、`SamsungBrowser 29`（UA 是 29.0.4.3）、`MiuiBrowser 16`（16.0.521824）、`HuaweiBrowser 17`（17.0.8.310）、`MQQBrowser 14.3`、`UCBrowser 16.5`。**没动的两处**：Safari/Firefox 内核段保留 UA 原样 major.minor（`Safari 18.5` 的 .5 有信息量），容器版本不裁（`App WeChat 8.0`/`App ZCode 3.14.4` 是应用版本，不是浏览器版本，且面板去重规则会把 `3.14.4` 整个搬到 deviceName 后面）。**另查出真缺陷（未修）**：二进制 WS 帧在探针上报前就被 JSON 序列化毁了（`packages/probe/src/network/websocket.proxy.ts:51-66` 原样塞 `ArrayBuffer`/`Blob`/`Uint8Array` → `{}` 或 `{"0":1,…}`），hub 侧 `normalizeWsData` 的 base64 分支在生产不可达，ADR-001 决策 3「二进制兜底放 hub 侧」是错的，第 7 轮那条 e2e 断言因假探针预编码而自证。`parseDeviceLabel` +7 条断言（桌面 Chrome 无徽标 / 微信仍命名 / Edge 无前缀 / 四个国产壳），回归 67 → **74 全绿**（33+11+30）。）。**第二十五轮：两处可用性修复**——① 抽屉停在 Screenshot 再切另一台设备仍显示 Screenshot，`openSession` 现在经新抽出的 `selectTab()` 回落默认 System tab；② 华为平板标签丢设备/系统（UA 里 `Android 12; HarmonyOS; DBR-W00` 的 `HarmonyOS;` 让旧型号正则跨不过 `;`，只剩 `Chrome 132（Browser）`），设备段改按 UA 注释分词，并新增 HarmonyOS/OpenHarmony 系统名（不写兼容层的 Android 版本）、`· Mobile` 尾巴改用显式 `deviceOs` 判断。`parseDeviceLabel` +5 条纯函数断言，回归 62 → **67 全绿**）。**第二十四轮：html2canvas CDN 失败改 **多 CDN 回退链**——主源 `fastly.jsdelivr.net`（jsdelivr 的 Fastly 端点；`cdn.jsdelivr.net` 为其别名同样可用），unpkg/Cloudflare 兜底；每源 10s 超时（卡死不再只靠 onerror）。面板 Screenshot 实测出图成功。回归 62 全绿）。**第二十三轮：微信容器加 App 前缀——`（WeChat 8.0）` → `（App WeChat 8.0）`，与其他 app-shell 容器（App stock / App ZCode）视觉归族；单测验证 `Chrome 150（App WeChat 8.0）`。回归 62 全绿）。**第二十二轮：主标签浏览器段改为内核**——Edge 的 UA 里 `Chrome/153` 是渲染内核（决定 web 兼容性，调试真正关心的），`EdgA/153` 才是产品。标签变为 `Chrome 153（Mobile Edge 153.0.0.0）`：主段 = 内核主版本（Chrome 取主版本），括号 = 形态+真实浏览器+全版本（有 Edg token 时覆盖 Browser/PC）；非 Edge 浏览器括号保持原样。实测：桌面 Edge `Chrome 154（PC Edge 154.0.0.0）`、手机 Edge 单测 `Chrome 153（Mobile Edge 153.0.0.0）`；`parseDeviceLabel` 已随 bundle 导出便于单测。回归 62 全绿）。**第二十一轮：Chrome 只显示主版本**（`Chrome/150.0.7871.181` → `Chrome 150`——多为 webview 内核，全版本号冗长）；Edge/Firefox/Safari 仍保留完整版本）。**第二十轮：浏览器段取 UA token 原样的完整版本号**（`Chrome/146.0.7680.80` → `Chrome 146.0.7680.80`；Edge UA 里 `Chrome/154.0.0.0` 只是内核，真浏览器是 `Edg/154.0.0.0` → 显示 `Edge 154.0.0.0`，内核名绝不冒充浏览器名）。实测 `Chrome 146.0.7680.80（App ZCode 3.14.4）`。回归 62 全绿）。**第十九轮：App 身份解析三级来源**——① Electron 应用取 UA 里第一个非引擎的 `Name/version` token（ZCode/3.14.4 → `Chrome 146（App ZCode 3.14.4）`，注意必须**遍历**全部 token 跳过 Mozilla/AppleWebKit 等已知标记，只 match 第一个会撞上 Mozilla/5.0）；② webview 壳：版本取尾部 `(x; 版本)` 组、名字取 `scheme/hazq` token（无 scheme 回退 x）→ `Chrome 150（App hazq 2.4.5）`；③ 都没有 → Electron 运行时版本或裸 `（App）`。三台实机验证：App stock 5.5.2 / App ZCode 3.14.4 / App hazq 2.4.5。回归 62 全绿）。**第十八轮：App/WeChat 分类带上容器版本，且 **`; wv)`（Android WebView 标志）强制归类 App**——不再因 UA 含 Chrome/Safari 被误判为 Browser（用户实机 UA：`...Chrome/150... UPHybridSDK/3.0 (stock; 2.4.5) hxtheme/0 scheme/hazq`，`(stock; 2.4.5)` 即 app 标识+版本）。App 版本来源：Electron/版本 →（App 41.0）；尾部 `(appId; 版本)` 组 →（App stock 2.4.5）；WeChat → MicroMessenger 版本 →（WeChat 8.0）；无名 webview →（App）。手机侧重连/刷新后生效。回归 62 全绿）。**第十七轮：标签布局按用户示例定为 **设备 · 系统 · 浏览器 版本（分类）**——浏览器名+版本回到主标签，分类放全角括号：MicroMessenger/wxwork→（WeChat）、Electron→（App）、桌面→（PC）、移动独立浏览器→（Browser）、移动无浏览器签名→（App）。实测三类：Edge 153（Browser）/ Chrome 150（WeChat）/ Chrome 146（PC 上 Electron 归 App）。回归 62 全绿）。**第十六轮（被第十七轮迭代）**：设备标签布局改为用户指定格式 **设备 · 系统 · PC|Mobile · WeChat|App|Browser**——第三段设备形态（移动 UA 含 Android/iPhone/iPad/Mobile/HarmonyOS → Mobile，否则 PC），第四段容器分类（MicroMessenger/wxwork → WeChat；Electron → App；含 Safari/Chrome/Edg/Firefox/国产壳等浏览器标识 → Browser；无标识的移动 UA → App 内嵌 webview）；具体浏览器名+版本段被分类替代（信息换取可读性）。三类实测：Mobile·Browser（Edge）、Mobile·WeChat（微信内）、PC·App（Electron）。回归 62 全绿）。**第十五轮**：Storage 新增**删除**能力——协议双副本 `CmdType`/`ToolApiName` 加 `del_storage`（探针 `delStorage`：local/session 用 removeItem、cookie 写过期值，均回读确认 `deleted`；`tools.ts` 分发；**刻意不注册为 MCP 工具**，仅面板 `/api/tool` 使用——需要 agent 侧删除时在 `mcpServer.ts` 注册即可）；面板行内「修改 删除」双按钮，删除后刷新并显示结果。真机/桌面回归 62 全绿）。**第十四轮**：**hub 端口 9330 → 9528**（用户要求），全仓默认值/文档/demo 默认连接/注入片段同步；测试端口 proxy-smoke/browser-e2e 改 9345/9346 避让；手机侧需刷新页面重新拿注入才会连新端口。回归 62 全绿）。**第十三轮**：Network 详情改 Chrome DevTools 风格——可折叠分区 + 键值 table（`parseHeaders` 解析 `{k:v}`/`[[k,v]]`/HTTP 行三种格式，值内逗号并回前一对）；System/Storage 同款 table 布局；行内手风琴展开（查询参数/标头/载荷，requestId 记忆展开态，SSE 重绘不丢）；**又踩模板字符串正则坑**（`/\r?\n/` 断裂致面板全挂，自检脚本已固化到构建前）。回归 62 全绿）。**第十二轮**：真机型替换主标签（`HelloMsg.realDevice` 结构化字段，协议双副本；兼容旧探针 deviceName 格式，重连即生效；真机 M2011K2C · Android 14 实测达标）。**第十一轮**：探针 Client Hints 取真机型。**第十轮**：刷新按钮收敛（删 Logs/Network、留 System/Storage、Storage 实时 + filter oninput）+ 按钮换行修复。**第九轮**：面板 1s 轮询改 **SSE 实时推送**（`GET /api/events`，hub `onData`/`onSessionEvent` → 200ms 防抖广播，EventSource 断线自动回落轮询）。**第八轮**：修 bridge 网络过滤失效；demo 探针 no-store；真浏览器视觉复验；whistle 10s 自愈接管实测。**第七轮**：第 12 个工具 `ws_frames`。**第六轮**：Network 瘦身 + type 分桶、System 置首、eval 并入 Logs 底部、会话按接入顺序排序、MCP配置浮层。
本文档供接管的其他模型/agent 直接开工：先读本文，再读 README，最后看标注的几个关键文件。

---

## 一、项目一句话

基于 fork 的 [Tencent vConsole](https://github.com/Tencent/vConsole)（dev 分支）做一套面向 AI agent 的移动端 H5 调试 MCP 工具（类 Chrome CDP）：页面里跑探针，把 console/network 数据经 WebSocket 上报给 hub，agent 通过 12 个 MCP 工具读日志、看网络、拉 WS 帧、eval、截图、改 storage。MCP server 装在 **whistle 插件**里：`w2 start` 起全家桶，`w2 stop` 全关；插件自带规则会给被代理的 HTML 页面自动注入探针，**页面零改动**。

## 二、架构（当前态）

```
H5 页面（vConsole fork 探针）
  │  接入三选一：① whistle 规则注入（页面零改动）② npm 包 @bobjoy/vconsole ③ Vite 插件 @bobjoy/vconsole-vite
  │  initMcpBridge → WS 指数退避重连 → hub
  ▼
ws://<lan>:9528  Hub（多会话注册 / 活跃会话 / 游标缓冲 / 命令分发 / 日志网络环形去重）
  │  同一个端口还是 http 资源口：GET /html2canvas.min.js → packages/whistle-plugin/vendor/（src/staticAssets.ts）
  │  探针截图优先从这个它本来就连得上的源加载 html2canvas，公网 CDN 仅兜底 → 纯内网可截图
  │  由 whistle 插件进程持有（whistle 没起时可用独立 stdio 进程持有，hub/proxy 双模式互备）
  ▼
@bobjoy/whistle.vconsole 插件（装在 whistle，随 w2 起停）
  ├─ rules.txt        注入规则（随插件自动生效）：* htmlPrepend://http://127.0.0.1:9527/inject.html enable://strictHtml
  ├─ lib/runtime.js   启动 createBackend + HTTP server（:9527）
  ├─ /inject.html     whistle 在本机抓取后内联进 HTML 的 <script src=…/probe.js> + new VConsole({serverUrl})
  ├─ /probe.js        探针 bundle（packages/probe/dist/vconsole.min.js 的副本，321KB）
  ├─ /mcp             MCP Streamable HTTP（stateless，每请求新建 McpServer + 传输，JSON 应答）
  ├─ /api/tool        面板 Drawer 调用的 REST 端点（12 工具，sessionId 定向）
  ├─ /api/sessions    会话列表（面板左侧列表）
  └─ /  面板 HTML（左：设备列表，按接入顺序；右：按 session 的 Drawer 调试面板，System/Logs/Network/Storage/Screenshot，执行 JS 在 Logs 底部，不含 Element）
```

手机侧只需能访问开发机 LAN IP 的 9527（取探针）和 9528（WS）；`inject.html` 里的 LAN 地址在 boot 时由 `getLanAddresses`/`createBackend` 实时算出，不落盘任何机器相关信息。

**决策文档**：`docs/adr/0001-ws-frames-incremental-hub-side.md`（`ws_frames` 帧缓冲形态；含第二十七轮的修订——二进制帧改由探针预编码，原「零探针改动」作废）、`docs/adr/0002-single-http-port-and-no-relay.md`（端口职责 + 网络边界 + relay 为什么搁置）、`docs/specs/2026-10-04-ws-frames-incremental.md`（ws_frames 规格）、`CONTEXT.md`（术语表：会话 / 探针 / hub / 帧 / 容器分类）。

MCP 客户端配置（`.zcode/config.json` 现状）：

```json
{
  "vconsole": { "type": "http", "url": "http://127.0.0.1:9527/mcp", "enabled": true },
  "vconsole-stdio": { "type": "stdio", "...": "独立 node 进程回退方案", "enabled": false }
}
```

12 个工具：`list_sessions` `select_session` `get_logs` `get_network` `ws_frames` `wait_for` `eval_js` `get_dom` `get_storage` `set_storage` `get_page_info` `screenshot`。所有工具支持可选 `sessionId` 定向（不传用活跃会话）。

`get_network` 两种形态：**列表模式**（`urlFilter`/`type`=css·js·img·xhr·ws·other/`since`/`limit`）只回摘要字段，**详情模式**（`requestId`）才回 headers、body、WS 帧——因为工具结果文本有 60KB 上限，列表带 body 会被截断成非法 JSON。

`ws_frames` 与 `get_network` 互补：`get_network` 的 `type=ws` 只告诉你「有条 WS 连接」，`ws_frames` 直接增量拉这条连接上流动的帧（send/receive）。数据全在 hub 侧——探针把网络上报里的 `requestType=websocket` 条目的 `messages` 摊平成帧，塞进 `Session` 独立的 2000 条环形缓冲（`wsFrameBuffer`，与 `networkBuffer` 分离、互不驱逐）。`wsUrl` 过滤到单条连接，`sinceFrameTime` 是时间戳游标（增量拉），`limit` 默认 50，`oldestSeq` 提示 2000 帧环形缓冲已溢出、最老帧被顶掉。**二进制帧**：上报是 JSON，`ArrayBuffer`/`Blob` 原样 push 会在页面侧就变成 `{}`，所以由探针 `packages/probe/src/network/wsCodec.ts` 的 `encodeWsData` 预编码成 `WS_BINARY_MARKER + base64`（>8192 字节只留前 8KB 并追加 `:原始字节数`），hub `normalizeWsData` 剥标记后回纯 base64、截断信息进帧的 `totalBytes`；`binaryType` 默认的 Blob 读字节是异步的，探针先落 `Blob(size)` 占位、读到后改写那条 message，hub 的 `expandWsFrames` 比对尾帧原值并**刷新原帧**（不重复追加）。

## 三、仓库结构

pnpm monorepo（根包名 `whistle-vconsole`，private），npm 命名空间 `@bobjoy`：

| 包 | npm 名 | 说明 |
|---|---|---|
| `packages/probe` | `@bobjoy/vconsole` | fork 版 vConsole + `src/mcp/`（bridge、WS 客户端、console hook 守卫、命令执行、序列化防护）；产物 `dist/vconsole.min.js`（webpack target=web） |
| `packages/whistle-plugin` | `@bobjoy/whistle.vconsole` | whistle 插件（**含 MCP server**）：`src/*.ts`（hub/session/tools/mcpServer/cli/deviceLabel/staticAssets，加上工作区包 `@bobjoy/vconsole-protocol`，esbuild 出 `dist/index.cjs` + `dist/cli.cjs`）、`index.js`（whistle hook）、`lib/runtime.js`（注入资源 + MCP HTTP + 面板 + API）、`lib/panel.js`（Drawer 面板 HTML）、`rules.txt`、`vendor/html2canvas.min.js`（截图依赖，hub 端口 serve，`build.mjs` 校验存在性）、`build.mjs`（出 tgz）、`test/`（e2e）。stdio 回退由本包 `bin: whistle-vconsole`（`dist/cli.cjs`）提供 |
| `packages/vite-plugin` | `@bobjoy/vconsole-vite` | dev 模式自动注入探针（零代码侵入），依赖 `@bobjoy/vconsole` 取 bundle |
| `packages/protocol` | `@bobjoy/vconsole-protocol`（`private: true`） | 协议唯一定义源 `src/protocol.ts`；两侧构建期内联，不发包、不出现在发布物里 |
| `packages/whistle-plugin/test/` | — | 回归 5 套（合计 105 项）：`ws-codec.unit.mjs`（10，探针二进制帧预编码）、`screenshot-loader.unit.mjs`（9，html2canvas 本地优先加载链 + 桥接接线）、`e2e.mjs`（37，stdio，端口 9340）、`multi-session.e2e.mjs`（11，9341）、`http.e2e.mjs`（38，9343，官方 SDK StreamableHTTP 客户端）；另有 `browser-e2e.mjs`/`proxy-smoke.mjs`/`diag-hub.mjs`（真浏览器/代理链路，手工跑） |

**协议只在 `packages/protocol`（`@bobjoy/vconsole-protocol`，`private: true`）定义一份**：`src/protocol.ts` 是探针与 MCP server 共用的唯一消息协议源，插件侧 esbuild、探针侧 webpack 都把它**内联**进各自单文件 bundle（bundle 里搜不到这个包名），发布物中也不存在它。探针的 `dist/vconsole.min.d.ts` 由 `build/build.typings.js` 现场生成协议声明并包成 `declare module "@bobjoy/vconsole-protocol"` 块，消费者无需安装该包。改协议只改这一个文件。

## 四、构建 / 安装 / 验证命令

```bash
pnpm install
pnpm build            # 串行：probe → vite → whistle-plugin（typecheck + esbuild + build.mjs 出 tgz；插件要读 probe 的 dist，顺序勿改）
pnpm test:e2e         # ws-codec 10 + screenshot-loader 9 + stdio 37 + multi-session 11 + http 38 = 105，五套全绿
pnpm demo             # http://localhost:9443，页面内已带探针（默认连 ws://localhost:9528）

# 只重建插件的 MCP bundle（改 src/*.ts 后）
pnpm --filter @bobjoy/whistle.vconsole bundle     # esbuild → dist/index.cjs + dist/cli.cjs
node packages/whistle-plugin/build.mjs            # 或 pnpm --filter @bobjoy/whistle.vconsole build，出 whistle.vconsole-0.3.0.tgz
# → 3.5MB tgz：index.js + rules.txt + lib/ + dist/{index.cjs,cli.cjs,probe.js} + vendor/html2canvas.min.js + 物化的 node_modules（SDK/ws/zod 走 bundleDependencies，可离线装）

# 安装到本机 whistle（旧包名 whistle.vconsole-mcp 必须先卸，否则抢 9528/9527）
w2 stop
w2 uninstall whistle.vconsole-mcp
w2 install whistle.vconsole-0.3.0.tgz
w2 start
curl -s http://127.0.0.1:8899/whistle.vconsole/ -o /dev/null   # 触发 boot（懒加载，见坑 11）
curl -s http://127.0.0.1:9527/inject.html                       # 应输出带当前 LAN IP 的两段 script
```

探针端手工接入（不走 whistle 注入时）：

```js
import VConsole from '@bobjoy/vconsole';
new VConsole({ serverUrl: 'ws://127.0.0.1:9528' });
```

鉴权：无。hub 只按 LAN 可达性接受连接，`~/.whistle-vconsole/hub.json` 记录 `{port,lan,updatedAt}` 供其他进程自动发现。

## 五、改动清单

**第二十七轮（发布前自查批：协议单源 → 二进制 WS 帧 → isTablet → 去重纯函数 → html2canvas vendor → 发布前置 → 文档边界）**
- **#15 协议单源**：抽回 `packages/protocol`（`@bobjoy/vconsole-protocol`，`private: true`），两侧构建期内联，删掉人工同步的双副本 `protocol.ts`；探针 `dist/vconsole.min.d.ts` 由 `build/build.typings.js` 现场生成协议声明并包成 `declare module` 块（细节见第三节）。
- **#16 二进制 WS 帧**：ADR-001 原「零探针改动」在二进制上不成立（ArrayBuffer/Blob 经 JSON 上报变成 `{}`）。新增 `packages/probe/src/network/wsCodec.ts` 预编码为 `WS_BINARY_MARKER + base64`，超 `WS_BINARY_MAX_BYTES=8192` 截断并附 `:原始字节数`，hub `Session.normalizeWsData` 剥标记、`expandWsFrames` 按 `expandedUpTo` 只摊增量尾部并刷新被改写的尾帧（Blob 是异步读的）。单测 `test/ws-codec.unit.mjs`（10 项）。
- **#17 iPad 桌面模式**：协议 `realDevice` 加 `isTablet`（Client Hints `maxTouchPoints`），修 iPad 桌面 UA 与 Mac 同形导致的误判。
- **#18 卡片去重纯函数**：面板 `.dev`/`.muted` 括号剥版本那段逻辑抽成纯函数 + 单测，面板侧改为内联注入（避开模板字符串吃正则的坑）。
- **#19 html2canvas 本地优先**：`vendor/html2canvas.min.js`（1.4.1，sha256 `e87e5507…eab8cb`）进插件，hub 端口兼作只读资源口（`src/staticAssets.ts`，`GET /html2canvas.min.js`）；探针按 `serverUrl` 做 `ws→http` 同源替换得出地址（`bridge.ts:localAssetUrl`），CDN 链退为兜底 → **纯内网也能截图**。`build.mjs` 缺 vendor 文件即抛错。单测 `test/screenshot-loader.unit.mjs`（9 项：加载链 + 桥接接线两条断言）。
- **#20 发布前置**：`examples/demo-h5/index.html` 去掉真实 LAN IP（改 `location.hostname` + `?ws=` 覆盖）；三个包补 `publishConfig`（钉 npmjs + `access: public`）；解包扫描（无 IP/绝对路径/机型串，probe 排除 `*.tsbuildinfo`）。**四项待拍板**已列在第八节第 2 条。
- **#21 文档边界**：新增 `docs/adr/0002-single-http-port-and-no-relay.md`（端口职责、三条网络边界、面板由 whistle serve 与公网 relay 两个备选为何否决）；README 加「网络边界」条目 + 路线图标记 relay 搁置；`CONTEXT.md` 补「hub 资源口」术语并把「二进制帧兜底」改成探针预编码口径。
- **#22 收尾**：回归 **105 全绿**（10+9+37+11+38）、`pnpm build` 绿、`w2 install` 后真浏览器复验截图；本文件第四/六/七/八节的端口（9330→9528）、测试数、`vendor/` 与「协议双副本」旧说法全部对齐现状。
- **本轮查出的真缺陷（已修）**：`bridge.ts` 的 `screenshot` 分支漏传 `assetUrl`（`this.assetUrl` 算了没用），本地优先链在真页面上静默失效、照旧走 CDN——单测当时只 bundle 了 `commands.ts`，看不见这层接线，所以是绿的。现在 `screenshot` 传 `assetUrl: this.assetUrl`，并给单测加了两条源码级接线断言（`the bridge derives…` / `the bridge hands that url to screenshot()`）钉住这个回归；真页面复验：`performance` 里只出现 `http://localhost:9528/html2canvas.min.js`，无任何 CDN 请求。

**第十三轮（DevTools 式详情 + System/Storage table 布局，仅 `lib/panel.js`）**
- Network 详情重写为 Chrome DevTools 风格（用户截图样式）：`<details>` 可折叠分区（▾ 响应标头/请求标头/请求载荷/响应内容）+ 每个标头分区带"原始"checkbox（键值 table ↔ 原始文本切换）+ 键值两列 `table.headers`（name 列 30%、mono 字体、hover 高亮）。探针 header 经 `serializeOne` 是 `{k: v}` 或 `[[k, v]]` 单行字符串，面板 `parseHeaders()` 三格式解析（对象/数组/HTTP 行）成键值对；顶层逗号分割是括号深度感知的，**值内逗号**（Date/Cache-Control 极常见）会切碎键值对——无 ": " 的碎片并回前一个 pair（实测 date 头完整 "Mon, 05 Oct 2026 02:52:34 GMT"）。
- System：`.kv` 行改 `table.headers` 两列；Storage：同样套 `table.headers`（`td.k` 30% / `td.ops` 110px 右对齐）。
- **又一个模板字符串坑（坑 17 变体）**：`panel.js` 模板里的正则 `/\r?\n/` 被模板解析成真实换行，正则字面量断裂、整个 script 语法崩掉、面板卡在 loading。修复 `\\r?\\n`；自检脚本固化：`node -e "…require panel.js → 抽 <script> 段…" && node --check`（build 前跑）。
- script 资源（Resource Timing 捕获）无 header/body，详情只显示标题行属正常。
- 验证：fetch 请求详情四分区齐全、date 头完整、原始切换正常、System/Storage 表格截图核对通过；回归 62 全绿。
- 后续微调（用户反馈）：**去掉"原始"切换**——标头分区只显示键值 table（`.rawtoggle`/`toggleRaw` 已删）；解析失败时仍回退纯文本但无切换控件。**Network 列表长 URL 换行**——`td.url` 加 `word-break: break-all`（原 `max-width:340px` 在 auto 表格布局下不约束、长 URL 溢出到 Status/Time 列）；title 悬停看全量、详情里有完整 URL。**行内手风琴展开**——点击请求行在该行正下方展开详情（查询参数[URLSearchParams 解析]/请求标头/响应标头/请求载荷/响应内容），行高亮 `tr.exp`，再点收起；展开状态按 `requestId` 记录（`openDetailId`+`detailHtml` 缓存内容），SSE 触发的列表重绘会带着已展开的详情一起重建（不丢内容、不重新请求）；条目被驱逐/过滤后自动收起。**行 hover 高亮**——`#net-body tbody tr:not(.drow):hover td` 淡蓝 `#f7f9ff`（展开行 `tr.exp` 保持 `#f0f5ff` 区分）。**Storage 行垂直居中**——`#sto-body td { vertical-align: middle }`（`.headers` 继承的 top 对齐让 key/value 贴顶、与按钮中线不齐）。**编辑态改 textarea**——点「修改」从单行 input 换成 3 行 textarea（`resize: vertical`，值作为元素内容 esc 写入而非 value 属性；保存/全选逻辑不变，`.value` 对两者通用）。

**第十二轮（真机型替换主标签，用户确认效果达标）**
- 上一轮把真机型放进 `deviceName`（卡片括号），用户要求直接替换 "K · Android 10" 本体。
- 协议双副本同步（`packages/{probe/src/mcp,whistle-plugin/src}/protocol.ts`）：`HelloMsg` 加 `realDevice?: { model, osVersion }`。探针 `fetchRealDevice()` 改存结构化对象；hello 带 `realDevice`，`deviceName` 回归"仅用户显式设置"。
- hub 侧标签组装（`deviceLabel.ts` + `session.ts`）：`parseDeviceLabel(ua, real?)` 在安卓分支优先用 client-hints 的 model/版本（版本取 `platformVersion` 主版本号）；**旧探针兼容** `realDeviceFromDeviceName()`——上一代探针把真机型自动填在 `deviceName`（"M2011K2C · Android 14" 格式），解析回填，已在线的页面重连即生效、无需刷新。
- 面板括号去重：`deviceName` 是 `deviceLabel` 前缀时不再显示括号（旧探针过渡期两者内容相同）。
- 验证：`w2 restart` 后手机（旧探针，未刷新页面）标签即变 `M2011K2C · Android 14 · Edge 153`；刷新页面加载新探针后走结构化 `realDevice`、`deviceName` 为空，显示一致；回归 62 全绿。

**第十一轮（Client Hints 真机型，解决 "K · Android 10" 占位符）**
- 背景：安卓 Chromium 的 UA reduction 把机型冻结为 "K"、版本冻结为 10，UA 解析出的标签分不清安卓设备。
- 改动（仅探针，`packages/probe/src/mcp/bridge.ts`，协议零改动）：构造时 `fetchRealDevice()` 调 `navigator.userAgentData.getHighEntropyValues(['model','platformVersion'])`，platform 为 Android 且 model 非 "K" 时存成 `realDevice = "M2012K11AC · Android 13"`；`onOpen` 的 hello `deviceName: opts.deviceName || realDevice`（用户显式 deviceName 永远优先）；首个 hello 前最多等 300ms（`Promise.race` cap，保证 autoConnect 不被环境问题拖死）。session/面板/MCP 侧零改动——`deviceName` 本来就贯穿（hello → session → list_sessions → 卡片括号）。
- 平台语义：macOS/Windows 或旧内核 webview（无 `userAgentData`）静默跳过，标签回退 UA 解析。
- 验证：探针重建后桌面（macOS，跳过 hints）300ms 内正常连接、回归 62 全绿；**真机型显示需手机刷新页面**（探针新 JS 只在页面加载时生效），刷新后面板卡片应显示 `K · Android 10 · Edge 153 (<真机型> · Android <真版本>)`。

**第十轮（刷新按钮收敛，仅 `lib/panel.js`）**
- Logs：删"刷新"按钮 + auto 勾选（连同 `logs-spin` 与 `loadLogs(withSpin)` 签名）——SSE 下 Logs 永远在线，`touched.logs` 直接 `loadLogs()`，fallback 轮询同步去掉 auto 判断。
- Network：删"刷新"按钮，**先**给 `#net-filter` 补 `oninput="netFilterChanged()"`（300ms 防抖）——此前输入筛选词唯一的生效途径就是点按钮。切 tab 到 network 仍强制重载。
- Storage：改"实时获取"——SSE `touched`（logs 或 network，页面活动暗示可能写 storage）且 pane 可见且**非编辑态**（`stoEditing`）时，节流 ≥1.5s 自动 `loadStorage()`（`get_storage` 是对页面的命令往返，不能每条日志都拉）；切 tab 到 storage 自动加载；"刷新"按钮保留，兜底静默写入（storage 变化探针不上报，hub 无从推送）。
- System："刷新"按钮保留，切 tab 到 info 自动加载一次。
- 验证：面板重载后全页只剩 2 个"刷新"（System/Storage）；Storage pane 可见时点 demo"写入 localStorage"（会打日志），2.5s 内 `demo_key`/`demo_cookie` 自动出现（未点刷新）；Network 输入 `api/test` 约 900ms 后列表只剩匹配行；回归 62 全绿。
- 样式修复（用户截图反馈）：Storage 编辑态"保存/取消"被 flex 压缩成竖排换行——按钮统一加 `white-space: nowrap; flex: none`，操作列 96px→110px（编辑态两按钮+间距约 106px）；"改"改文案"修改"。`lib/panel.js` 的按钮样式是 `.toolbar button, #console button, #sto-body button` 共用一条规则，新按钮默认继承 nowrap。

**第九轮（面板轮询 → SSE 实时推送）**
- 动机：设备列表与 Logs 每 1s 固定两次 HTTP（即使空闲）；日志/状态最坏 1s 延迟。
- **改动点**：① `src/hub.ts` `HubConfig` 加 `onData(sessionId, kind)`，在 `handleConnection` 的 `logs`/`network` case 缓冲后触发（hub 侧唯一数据汇聚点）；`src/index.ts` 透传（`StartOptions extends Partial<HubConfig>`，自动生效）。② `lib/runtime.js` 新增 `createSseHub`：200ms 防抖合并，flush 时经 `backend.handleTool('list_sessions')` 取快照，向所有 SSE 客户端写一条 `data: {type:'update', sessions, touched:[{sessionId,kinds}]}`；25s 心跳注释帧；`GET /api/events` 路由（text/event-stream，`req.close` 时清理）。③ `lib/panel.js`：`EventSource('/api/events')`——`sessions` 快照直接渲染（`renderSessions(pre)` 支持预取数据），`touched` 命中当前会话时按 kind 触发 `loadLogs()`（仍尊重 auto 勾选）/`loadNetwork()`（仅 Network pane 可见时）；`es.onerror → sseHealthy=false`，1s 轮询整段保留为 fallback（healthy 时直接 return）。
- **配套行为变化**：Network 列表加了与 Logs 同款的 diff 防重绘（`lastNet`）——推送触发重载时不再冲掉打开的请求详情；切到 Network tab 强制 `loadNetwork()` 一次（后台不可见时不拉，切来即新）。
- **设计取舍**：SSE 只做**变更通知**，数据仍走 `/api/tool`——过滤/去重/截断逻辑单点在服务端工具里，客户端不自己做 merge；fallback 与 SSE 共用同一套 load 函数。所以选 SSE 而非 WS：单向推送、原生自动重连、不用处理 HTTP upgrade、经 whistle 环回更稳。协议双副本不受影响（hub 内部 hook + 面板私有 JSON，未动 protocol.ts）。
- **验证**：`curl -N /api/events` 连接即 `retry:3000`，探针重连后 200ms 内收到合并推送（快照 + `touched:["sessions","network","logs"]`）；浏览器实测：点 demo 页"产生 console 日志"后 **600ms** 面板卡片 logCount 1→3（快于旧 1s 轮询周期）。回归 62 全绿（e2e 假探针走 WS 上报会触发 notify，但无 SSE 客户端时 flush 直接返回，无副作用）。
- 空闲时面板零流量（只剩 25s 心跳注释帧）。

**第八轮（真面板视觉复验 + bridge 网络过滤修复 + 缓存坑）**
- **bridge 网络过滤其实一直没生效（真 bug，已修）**：`probe/src/mcp/bridge.ts` 的 `tapNetwork` 给 model 设置了 `ignoreUrlRegExp`（排除探针自身 WS 连接），model 的 `updateRequest` 也确实按它拦截——但 bridge 对 `model.updateRequest` 的**包装层**是无条件 `appendNetwork(self.toNetworkItem(data))`，被过滤的条目照样推给 hub。于是页面 vConsole UI 看不到自身 WS，而 hub 的 `networkBuffer` 里永远有它，`get_network`/面板 Network 全被污染。修法：包装层同样 `this.ignoreUrlRegExp.test(data.url)` 命中即跳过推送。已实测：清缓冲后只进业务请求，自身 WS 不再出现。
  - **⚠ 与 `ws_frames` 的交互（重要权衡）**：自身 WS 条目不再进 hub 的 `networkBuffer` 意味着 `ws_frames` 拉不到**探针自身连接**的帧了（第七轮验证正是拿它当样本）。业务 WS 连接不受影响（不匹配 ignoreUrlRegExp，照常上报+摊帧）；e2e 假探针的 `ws-conn-a/b` 是显式 network 上报、不走探针 updateRequest 路径，也不受影响（62 项仍绿）。如果你确实需要观察探针自身连接的帧，revert `bridge.ts` 包装层那一处判断即可——但 `get_network` 会重新出现这条噪音。
- **demo 探针产物缓存坑（已修）**：`examples/demo-h5/server.mjs` 给 `/vconsole.min.js` 补 `Cache-Control: no-store`。此前改探针后 reload 页面跑的还是缓存里的旧 bundle，修复"看起来没生效"（本轮实际踩中，浪费一轮排查）。
- **真浏览器视觉复验 Drawer（IAB + 真 demo 页 + 真面板，非假设备）**：System 十行、Logs（级别过滤/关键词/auto/重复计数 `warn ×4`）、Logs 底部 eval 控制台（`document.title + ' | ' + location.pathname` → `→ whistle-vconsole demo | /` 0ms）、Network（列表 + 点行详情 Request/Response）、Storage（三桶 + 「改」按钮）、Screenshot（html2canvas 生成内嵌，视觉核对通过：左卡片蓝框选中态、tab 高亮、布局干净）。两张截图存会话 artifacts。
- **whistle 插件自愈接管实测**：手动起的 runtime 占着 9330/9527 时，whistle 内插件按 10s 周期静默重试；kill 手动进程后 ≤10s whistle 接管两个端口（owner=whistle 主进程），探针自动重连、`/mcp` tools/call 正常。与坑 20 的机制吻合，实测闭环。
- **回归数字勘误**：`pnpm test:e2e` 实测 **stdio 33 + multi-session 11 + http 18 = 62**（本文第四、九节的 21+11+16 是旧数字；第六节 148 行的 27 也过时了），已把本节和脚本输出对齐。另：e2e 全绿**不代表**自身 WS 过滤——假探针不走 updateRequest 路径，这类探针侧行为回归要靠真页面验证（本轮教训）。
- 收尾状态：修复后的探针已进 `whistle.vconsole-0.3.0.tgz` 并 `w2 install` + `w2 restart` 生效。

**本轮（第五轮起，按时间顺序：面板可用性 → token 删除 → 选项扁平化 → Network 修复 → 信息架构与排序）**
- `lib/panel.js`：`esc()` 从 Node 模块作用域挪进浏览器 `<script>` 内（面板是「一个导出 HTML 字符串的函数」，脚本里用到的任何 helper 都必须写在模板内部）；`hubBadge` 判活条件从 `d.status === 'ready'` 改为 `Array.isArray(d.sessions)`（`/api/sessions` 直接透传 `list_sessions` 的 `{ sessions }`，从来没有 `status` 字段，导致徽标恒显 `hub: undefined`）；会话卡片改为「内容变了才写 `innerHTML`」（2s 轮询无条件重建 DOM 会在按下鼠标时摘掉节点，点击被吞）。
- `lib/runtime.js`：`boot()` 不再在失败路径里 `throw`（未处理的 Promise rejection 会带走整个 whistle 进程，表现为 9330/9527 突然无人监听）；`EADDRINUSE` 时先探一次 `:9527/api/sessions`，确认是自己人占着就转入待机并 10s 后重试接管；`listen` 成功后补了常驻 `httpServer.on('error')`；`listen` 失败时 `hub.stop()` 释放 9330。
- `src/index.ts`：`VERSION` 0.1.0 → 0.3.0（与 `package.json` 对齐，之前 `--version` 横幅和 MCP server info 都报旧号）。
- 删掉遗留产物 `packages/whistle-plugin/whistle.vconsole-mcp-0.1.0.tgz`（旧包名时代的 tarball）。
- **面板文案/交互**（`lib/panel.js`）：标题「vconsole-mcp 设备面板」→「设备列表」（`<title>` 与 `<h1>` 同步）；徽标 `hub connected` → `running`、失败态（含 fetch 抛错）统一 → `stopped`；右上角 `MCP: http://…/mcp` 换成 `<details id="mcp-help">`「MCP 配置指引」，点开是可直接粘的 `{"type":"http","url":"http://127.0.0.1:9527/mcp"}`（纯 CSS 绝对定位浮层，无 JS）；卡片第三行的 `online`/`offline` 分别上绿/红色（`.st-on`/`.st-off`）；轮询 2s → 1s。浮层 `pre` 记得 `max-width: none`，否则被全局 `pre { max-width: 100% }` 夹成 79px 宽（实测 `getBoundingClientRect().width` 才发现）。（该浮层后续又改名为「MCP配置」、内容换成含 `mcpServers` 的完整 JSON、定位换成 `position: fixed`，见下面信息架构那条。）
- **MCP/面板 HTTP 端口 9331 → 9527**（`lib/runtime.js` 的 `MCP_HTTP_PORT`）：一个 server 承载 `/mcp`、`/api/*`、`/`、`/probe.js`、`/inject.html`，所以 `rules.txt`、面板「MCP 配置指引」浮层、README、`.zcode/config.json` 同步改；WS hub 仍是 9330。改完务必按坑 20 的流程重装并杀掉残留进程，否则旧进程还在 9331 上、新口起不来。
- **token 鉴权整条链路删除**（LAN 调试工具，一个旋钮就够）：hub 侧 `handleConnection` 不再读 `?token=`、不再有 4401 拒绝；`HubConfig`/`ProxyHubOptions`/`CreatedBackend`/`StartedVconsoleMcp` 去掉 `token` 字段；`src/index.ts` 删掉 `generateToken()`、`DEFAULT_TOKEN`、`readDiscoveredToken()` 和 `WHISTLE_VCONSOLE_TOKEN` 环境变量（`hub.json` 现在只写 `{port,lan,updatedAt}`）；CLI 去掉 `--token`；`probeSnippet(serverUrl)` 单参；探针侧 `WSClientOptions`/`VConsoleMcpOptions`/`HelloMsg` 删 `token`（连接 URL 只带 `?sid=`）；vite 插件选项删 `token`；`buildInjectHtml` 注入的 `new VConsole({ mcp })` 只剩 `serverUrl`；demo 页删 `?token=` 覆盖；测试同步（`e2e.mjs` 的「bad token rejected (4401)」断言随功能一起删除）。**副作用**：proxy 模式原来靠 token 相同来确认「9330 上是自己人」，现在只按「能否按 api 协议应答」判断（`proxyHub` 的 `unexpected-response`/close 仍会报错）。
- **探针接入选项扁平化**（用户指定写法 `new VConsole({ serverUrl })`）：`VConsoleOptions` 去掉 `mcp?: VConsoleMcpOptions` 嵌套，改为顶层 `serverUrl/deviceName/autoConnect/hideUI/maxBuffer`（`core/options.interface.ts`）；`core.ts` 以 `option.serverUrl` 是否存在决定是否起 bridge，并显式组装内部 `VConsoleMcpOptions` 传给 `initMcpBridge`；`VConsoleMcpOptions` 仍是内部类型（`src/mcp/protocol.ts`），`src/mcp/options.ts` 这个纯转发文件删掉，`vconsole.ts` 的类型改从 `./mcp/protocol` 导出。三个接入点同步：whistle `buildInjectHtml`、vite 插件注入代码（顺带去掉 `window.VCONSOLE_MCP_CONFIG` 全局，直接内联 JSON）、`examples/demo-h5/index.html`（不再手写 `deviceName`，靠设备指纹生成），`probeSnippet()` 输出的片段也改成顶层写法。**顺带砍掉的旋钮**：`mcp.ignoreUrlRegExp`（string 版二次过滤器）全仓零调用点，且与 vConsole 原生 `network.ignoreUrlRegExp`（RegExp）同名不同型容易混，删除后 bridge 只保留「自动排除自己的 WS 连接」这一条内置过滤，镜像 `src/protocol.ts` 同步。
- **Network 面板报错修复 + 请求类型筛选**（`session.ts`/`tools.ts`/`mcpServer.ts`/`lib/panel.js`）：点「刷新」报 `Cannot read properties of undefined (reading 'map')` 的根因是 `get_network` 列表模式把整条 `NetworkItem`（含 `requestHeader/responseHeader/postData/response/getData/messages`）都吐出来，100 条 77KB 超了 `MAX_TEXT_CHARS=60_000`，`jsonResult` 截断后不是合法 JSON，面板 `api()` 拿到字符串再取 `.items` 自然是 undefined。修法：列表行改为 `NetworkListItem`（逐字段列出摘要，重量级字段只在 `requestId` 详情模式给，实测同样 12 条从 77,646B 降到 6,425B）；面板 `api()` 增加「文本里含 `[truncated by whistle-vconsole]` 就抛中文提示」和 `Array.isArray(d.items)` 兜底，不会再出现 `reading 'map'`。**新增 `type` 分桶筛选**：`networkBucket()` 把探针的 10 种 `requestType` 映射为 `css`(stylesheet)/`js`(script)/`img`/`xhr`(xhr+fetch+ping+custom)/`ws`/`other`，`getNetwork` 支持 `type`，MCP schema 用 `z.enum([...])`，面板工具条加 `<select id="net-type">`（全部类型/css/js/img/xhr/ws/other，`onchange` 即重载）。列表行同时带 `requestType`（原值，展示用）和 `bucket`（分桶，筛选语义）。
- **面板信息架构 + 会话排序**：
  - `src/hub.ts` `listSessions()`：排序从「在线优先 + `lastSeenAt` 倒序」改为**只按 `firstSeenAt` 升序**（接入顺序）。原排序会让列表随每条新日志/请求跳动重排，面板 1s 轮询下点不准。`active` 字段照旧返回（agent 靠它定位默认目标），只是面板不再显示徽标。
  - `lib/panel.js`：tab 顺序改为 **System（原 Info，排第一，默认打开）/ Logs / Network / Storage / Screenshot**；原 Console tab 删除，执行 JS 的输入框 + Run + 结果区整体移到 Logs pane 底部（`#console` 加 `border-top` 分隔）；卡片去掉 `active` 徽标并删掉随之失效的 `.badge` CSS；右上角「MCP 配置指引」改名「MCP配置」，浮层内容由静态片段改为 JS 实时生成的**完整可粘贴配置** `{"mcpServers":{"vconsole":{"type":"http","url":"http://<location.host>/mcp"}}}`（host 跟随当前访问地址，手机/局域网访问时不会给出错的 127.0.0.1）。
  - **浮层定位坑（本轮实测）**：`#mcp-help pre` 原来是 `position:absolute; right:0`，宽度 320→400 后在窄窗口下会从列表列左侧溢出到屏幕外（`innerWidth=684` 时 `#list` 被 flex 收缩到 `min-width:320`，浮层 `left` 算出来是 **-97**）。改为 `position: fixed; right: 12px; top: 48px; max-width: calc(100vw - 24px)`，实测 `left=272 right=672` 完整可见。量测要同时看 left/right，只量 width 会漏。
  - README：http 接入片段补成含 `mcpServers` 的完整 JSON 并指向面板「MCP配置」；面板描述改为新 tab 结构与接入顺序排序。`mcpServer.ts` 的 `list_sessions` 描述补上「ordered by connection time」。
- **Storage 可写（新增第 11 个工具 `set_storage`）**：探针侧 `commands.ts` 加 `setStorage(kind, key, value)`（`kind` = `local`/`session`/`cookie`），**写完一律回读**并把页面真实值返回（cookie 可能被 HttpOnly 拒写、localStorage 可能配额失败，回读才是事实）；cookie 用 `document.cookie = key=encodeURIComponent(value); path=/` 写，回读走同一个 `parseCookies()`，所以含空格的值编解码对称。`bridge.ts` 加 `case 'set_storage'`；`protocol.ts` 两侧同步加 `StorageKind`/`SetStorageResult` 并把 `set_storage` 塞进 `ToolApiName` 和 `CmdType`（**协议双副本，改一处必改两处**）；`tools.ts` 转发 `hub.sendCommand('set_storage', …)`；`mcpServer.ts` 用 `z.enum(['local','session','cookie'])` 收口。面板 `lib/panel.js`：Storage 每行加「改」按钮，点开变输入框（自动 focus + 全选）+ 保存/取消，键名走 `data-s`/`data-k` 属性 + 事件委托（键里有点号、中文都不怕，不用往 inline onclick 里拼字符串），保存后 `loadStorage()` 重读并在工具条显示 `key = value`。
- **旧名清扫**：`vconsole-mcp` 作为产品身份残留全部改为 `whistle-vconsole` —— 插件 `bin`、MCP server `name`、CLI 横幅/usage、runtime 日志与注入脚本的 `console.warn` 前缀、tools 截断提示、vite 插件的 `name` 与 `/@whistle-vconsole/probe.js` 虚拟路径、hub 发现目录 `~/.whistle-vconsole/`、环境变量前缀 `WHISTLE_VCONSOLE_{PORT,HOST}`、demo 页标题、README/注释。注意：本机仓库目录仍叫 `/study/project/vconsole-mcp`（`.zcode/config.json` 里的绝对路径按实际写），旧的 `~/.vconsole-mcp/` 目录已无人读写，可自行删除。

- **真实局域网 IP 清扫**：`README.md`（两处 `serverUrl` 示例）、`packages/vite-plugin/src/index.ts`（用法注释 + `serverUrl` 字段注释）、本文件第六轮证据行里的 `192.168.1.x` 全部换成 `192.168.x.x` 占位（与 `examples/demo-h5/index.html` 里用户自改的写法一致）。`192.168.1.10` 是协议注释里的通用示例，非本机地址，保留。解包 tgz 复扫：自有文件已无 IP、无 ``、无机型串；剩余命中全在第三方 `node_modules`（zod/hono/ip-address 等的测试用例）。

- **面板两处可用性修复（MCP配置浮层位置 + Logs 底部闪烁/JS 输入框不固定）**：
  - 浮层：上一版为躲「400px 宽在窄列里算出 `left=-97`」改成了 `position: fixed; right: 12px`，代价是它脱离触发器跑到视口最右边。正确做法是**把定位上下文放到 `#list header`**（`position: relative`），`#mcp-help pre` 用 `position: absolute; left: 12px; right: 12px; top: calc(100% + 2px); max-height: calc(100vh - 70px); overflow: auto`，宽度跟着会话列走（默认 420 列 → 396px，抽屉展开列压到 320 → 295px 也不折行），`#mcp-help` 自己的 `position: relative` 必须删掉否则又变成以 details 小盒子为基准。
  - Logs：根因是 1s 轮询**无条件重写 `#logs-body.innerHTML`**——重写瞬间 `scrollHeight` 塌成 0，`scrollTop` 被夹到顶部，于是下方输入框跟着上下跳（肉眼就是闪烁）。修法：① `#pane-logs.on` 改 `display: flex; flex-direction: column; overflow: hidden`，`#logs-body { flex:1; overflow:auto; min-height:0 }`，`#console { flex:none }` → JS 输入框钉在面板底部，列表在自己区域内滚；② 生成的 HTML 与 `lastLogs` 比对比才写（`openSession`/异常分支重置缓存）；③ 写之前判断是否在底部，是则贴底、否则原样恢复 `scrollTop`（往上翻历史不会被拽回顶部）；④ 工具条那个每秒闪一下的 `…` 改成只有手动点「刷新」才显示（`loadLogs(withSpin)`，markup 里 `onclick="loadLogs(true)"`）。

- **WS 帧增量拉取（新增第 12 个工具 `ws_frames`，hub 侧实现、探针零改动）**：探针早就会把网络上报里 `requestType=websocket` 的条目带出 `messages`（`websocket.proxy.ts` 的 `addMessage` 推帧），`get_network` 详情模式也能看到——但没有增量拉帧的入口，agent「挂在长连接上等推送帧」没工具用。全部逻辑放 hub 的 `Session`：
  - `addNetwork`（`src/session.ts`）在收网络上报时调 `expandWsFrames(item)`，把 WS 条目的 `messages` 摊平成 `WsFrame[]`（`wsUrl/seq/type/data/time`）追加进独立的 2000 条环形缓冲 `wsFrameBuffer`（`evictNetwork` 式的 `shift` 溢出），与 `networkBuffer` 分离互不影响。
  - **全量替换去重**：`addNetwork` 对已存在的 `item.id` 是整条替换（`existing.item = item`），而探针每次更新会**重推完整 `messages` 数组**——直接展开会重复入队。用 `expandedUpTo: Map<wsUrl, 条数>` 记「这条连接已展开到第几帧」，只补增量。
  - **seq 按 `wsUrl` 续号**：`wsUrlSeq: Map<wsUrl, number>`，每条连接独立 1、2、3…；`reset=true`（会话重连）时 `wsFrameBuffer`/`expandedUpTo` 一并清空。
  - **二进制兜底 `normalizeWsData`**：`data` 声明是 string 但二进制帧以 `ArrayBuffer`/`Blob`/`ArrayBufferView` 到达——string 原样，TypedArray/ArrayBuffer 走 base64（尊重 `byteOffset/byteLength`），其余 `JSON.stringify`、失败退 `String`。必须 hub 侧做，探针序列化后已定型。
  - `getWsFrames({ wsUrl, sinceFrameTime, limit=50 })` 返回 `{ frames, nextSince, oldestSeq }`：`nextSince` = 末帧 time（游标），`oldestSeq` = 环形缓冲最老帧的 seq（>0 即提示溢出、最老帧被顶掉，别信「从 seq 1 起步」）。`tools.ts`/`mcpServer.ts` 注册 `ws_frames`（`wsUrl`/`sinceFrameTime`/`limit` 全可选），`ToolApiName` 双副本（`packages/{whistle-plugin/src,probe/src/mcp}/protocol.ts`）都加 `'ws_frames'`。e2e 假探针多推两条 WS 连接（`ws-conn-a`/`ws-conn-b`），新增 7 条断言：流式 4 帧、二进制 base64、按连接 seq、`wsUrl` 过滤、`sinceFrameTime` 游标、无匹配回空。

**第二十五轮（面板切会话重置 tab + 华为/HarmonyOS 设备标签）**
- `lib/panel.js`：`openSession()` 原来只清数据（logs/net/detail/shot/eval）不切 tab——停在 Screenshot 再点另一台设备，抽屉仍开在 Screenshot（内容为空占位）。抽出 `selectTab(t)`（`classList.toggle(name, force)` 同时管按钮高亮与 pane 显示），tab 点击与 `openSession` 共用，切会话一律回落到默认的 System。
- `src/deviceLabel.ts`：设备段从「一条正则」改成**按 UA 第一个注释分词**。华为 UA 是 `Linux; Android 12; HarmonyOS; DBR-W00; HMSCore 6.16.4.352`——旧正则 `Android[^;]*;\s*([^;)]+?)…` 不能跨 `;`，型号和系统整段丢失，标签只剩 `Chrome 132（Browser）`。现在 `platformTokens()` + `PLATFORM_NOISE`（Linux/U/wv/Phone/Tablet/`Android x`/HarmonyOS/OpenHarmony/HMSCore 系列/`zh-cn` 这类 locale/裸版本号）取第一个非噪声 token 当型号，`Build/` 前截断。
- **HarmonyOS 归系统名，不再冒充 Android**：识别到 HarmonyOS/OpenHarmony 就 push `HarmonyOS [版本]` 并跳过 `Android n`——那是兼容层版本号，写它会让人以为在调安卓机。
- 尾部的 `· Mobile` 兜底原来靠 `!/iPhone|iPad|Android/` 字符串嗅探，改成显式 `deviceOs` 标志（设备/OS 一旦识别就不再加 Mobile）；OpenHarmony UA 自带 `Mobile` token，旧写法会多挂一段。
- `test/http.e2e.mjs`：`parseDeviceLabel` 直接从 `dist/index.cjs` 导入，+5 条纯函数断言（华为平板、OpenHarmony 无 Mobile 尾巴、普通安卓不变、locale 不当型号、client-hints 型号压过冻结的 `K`）。回归 62 → **67**。

**上一轮（第四轮：mcp-server 并入 whistle-plugin，仓库只剩 3 个包）**
- 删掉 `packages/mcp-server`：`src/*.ts`（hub/session/tools/proxyHub/mcpServer/protocol/cli/deviceLabel/index）整体搬进 `packages/whistle-plugin/src/`，`test/*.mjs` 搬进 `packages/whistle-plugin/test/`。
- 插件 `package.json` 吸收原 server 的依赖与构建：`dependencies` = SDK/ws/zod，`devDependencies` = typescript/esbuild/@types；`scripts.build` = `typecheck(tsc --noEmit) && bundle(esbuild) && node build.mjs`；`bin: { "vconsole-mcp": "./dist/cli.cjs" }`（stdio 回退形态）。新增 `tsconfig.json`（`module: ESNext` + `moduleResolution: Bundler` + `noEmit`，因为包是 CJS 而源码是 TS ESM，只做类型检查、产物全靠 esbuild）。
- `lib/runtime.js` 改成 `require('../dist/index.cjs')`，不再依赖 workspace 包 `@bobjoy/vconsole-mcp`。
- `build.mjs` 大幅简化：去掉「把 server 打成 file: vendor tgz」整段（原本是为未发布的包准备的），只校验 `dist/index.cjs`/`dist/cli.cjs` 存在、拷 probe bundle、`bundleDependencies` 只剩 SDK/ws/zod。tgz 从 3.5MB → 3.4MB，包内不再有 `vendor/`。
- 测试改指 CJS 产物：`../dist/cli.js` → `../dist/cli.cjs`；`http.e2e.mjs` 的命名导入改为 `createRequire(import.meta.url)('../dist/index.cjs')`（esbuild 的 CJS bundle 走 `require` 才稳，ESM `import` 命名导出靠 cjs-module-lexer 不可靠）。
- 根 `package.json`：`build` 序列变为 probe → vite → plugin，删掉 `build:server`，`dev:server` 指向插件的 esbuild `--watch`；`test:e2e` 路径改到 `packages/whistle-plugin/test/`。`.zcode/config.json` 的 stdio 那条改指 `packages/whistle-plugin/dist/cli.cjs`。

**更早一轮（包名收敛 + 协议内联 + 注入规则）**

- **包名收敛**：`@bobjoy/vconsole-mcp-probe` → `@bobjoy/vconsole`；`@bobjoy/vconsole-mcp-vite` → `@bobjoy/vconsole-vite`（独立发包，不再是 probe 的 subpath）；`whistle.vconsole-mcp` → `@bobjoy/whistle.vconsole`；仓库/根包名 → `whistle-vconsole`。scoped 插件名合法：whistle 校验 `/^(?:@[\w.~-]+\/)?(whistle\.[a-z\d_\-]+)$/`，tgz 名 `whistle.vconsole-0.3.0.tgz` 也过 `TGZ` 正则。
- **删除 `packages/protocol`**：类型内联到 probe 与 server 两侧（见第三节）。
- **插件自动注入探针**：新增 `packages/whistle-plugin/rules.txt`（`htmlPrepend` → `:9527/inject.html`）与 `lib/runtime.js` 里的 `/inject.html`、`/probe.js` 两个资源路由（`buildInjectHtml()` 拼实时 LAN 地址），页面侧不再需要引任何脚本。
- **删除死代码** `packages/whistle-plugin/lib/uiServer.js`（require 不存在的 `./hubClient`，早被 runtime.js + panel.js 取代）。
- **根 `build` 改为显式串行**（原 `pnpm -r` 不保证 probe 先于插件打包）；`test/e2e.mjs` 端口 9331 → 9340（原来撞插件的 MCP HTTP 口，导致必须在 whistle 停掉时才能跑；插件那个口现在是 9527）。
- **README 重排**为「whistle 插件为主、stdio 为回退」，接入探针写成三选一。
- `.gitignore`：根目录去掉 `lib/`（会忽略插件源码目录 `packages/whistle-plugin/lib`），补 `*.tgz`；`lib` 移到 `packages/probe/.gitignore`。

## 六、已验证（证据）

- `pnpm build` 全绿（probe webpack 314KiB 只有体积告警、vite-plugin tsc、插件 `tsc --noEmit` + esbuild 出 `dist/index.cjs` 38.7kb / `dist/cli.cjs` 39.2kb + 3.4MB tgz）。
- `pnpm test:e2e`：stdio 27 + multi-session 11 + http 18 全过，且**不需要停 whistle**。
- tgz 内容：`index.js` + `rules.txt` + `lib/{runtime,panel}.js` + `dist/{index.cjs,cli.cjs,probe.js}` + 物化的 `node_modules`（3977 项，SDK/ws/zod 全在内），**已无 `vendor/`**；解包到临时目录 `require('./index.js')`、`require('./lib/runtime')` 全部成功，零 registry 访问。
  - （注：这条说的是当时删掉的「未发布包 file: vendor tgz」目录。第二十七轮起 `vendor/` 以另一种身份回来了——`vendor/html2canvas.min.js` 是浏览器侧截图依赖，由 hub 端口 serve，不在 `node_modules` 里，`build.mjs` 校验其存在性。）
- **实机（合并后）**：`w2 uninstall @bobjoy/whistle.vconsole` + `w2 install whistle.vconsole-0.3.0.tgz` + `w2 start`。安装落点 `~/.WhistleAppData/custom_plugins/@bobjoy/whistle.vconsole/node_modules/@bobjoy/whistle.vconsole/`（whistle 约定：外层目录是 npm prefix，真包在嵌套的 node_modules 里，`whistle.inspect` 同构）。访问 `/whistle.vconsole/`（302）触发 boot 后 `*:9330`/`*:9527` 由 pid 41960 持有。
- **注入链路**：`curl -x 127.0.0.1:8899 http://127.0.0.1:9443/` → `<!DOCTYPE html>` 后紧跟注入的 `<script src="http://192.168.x.x:9527/probe.js">`；`probe.js`（JS 类型）经代理内容未被改写。
- **端到端**：浏览器开 demo 页 → `/mcp` 的 `list_sessions` 见 `dev-aab05b31`（online，logCount 37）、`eval_js("1+1")` 返回 `2`。
- **Drawer 六 tab 真实点验（本轮，第五轮）**：whistle 只在单帧里可控，所以用 `ws://127.0.0.1:9330` 挂了一个假设备（`dev-fake-panel`，完整回放 hello/logs/network + 应答 eval/get_dom/get_storage/page_info/screenshot）让面板当顶层页。结果：徽标 `hub connected`（绿）、卡片正常渲染；Logs 三级 + `error ×3` 重复计数；Network 表 + 点行出详情（requestId 二次查询拿到 header/body）；Storage 三张表；Console `document.title` → `"fake-eval-ok" 2ms`；Screenshot `<img src="data:image/png;base64,…">` 且 `naturalWidth>0`；Info 十行含 JS Heap 与 Timing。真实浏览器会话（`dev-aab05b31`，探针自连）此前已用 `/mcp` 验过 `list_sessions`/`eval_js`/`get_network`，面板走同一 `/api/tool` 后端。
- 注：假设备的 `page_info` 少回 `screen` 时 Info 会抛 `reading 'width'`——真探针 `getPageInfo()` 恒定输出 `viewport/screen/visibility/online`，属夹具缺口，不是面板缺陷（面板刻意不做兜底）。
- **Storage 写入复验（真页面 + 真面板 + 假存储设备）**：`/api/tool` 直连真页面（`dev-aab05b31`，重建后的探针）：`set_storage local vc-e2e=dark` 回读 `{"storage":"local","key":"vc-e2e","value":"dark"}`，`get_storage` 里 `localStorage` 确实多了这条；`set_storage cookie vc_cookie="hello world"` 回读原值（含空格的编解码对称）。面板侧因为只有一个顶层页，另起进程外挂一个会应答 `get_storage`/`set_storage` 的假设备（`dev-fake-store`）：Storage tab 渲染 4 行（cookie/local/session 三种桶，键名含点号也正常）→ 点「改」输入框 prefill 正确且拿到焦点（155px 宽）→ 保存后该行变 `light-2`、工具条显示 `theme = light-2`；cookie 行同样可改（`sid` → `xyz`）；「取消」不写入且输入框消失；离线会话进 Storage 显示 `probe … is offline` 红字。e2e 里三条新断言覆盖 local 写入+回读、写入落库、HttpOnly cookie 拒写报错。
- **面板信息架构改造复验（真面板 + 两个进程外假设备）**：另起一个 Node 进程按顺序连 `ws://127.0.0.1:9330?sid=dev-aaa-first`（iPhone UA）→ 2.5s 后 `dev-bbb-second`（Pixel UA），两边每 1.5s 推一条日志模拟活跃。结果：`/api/sessions` 顺序恒为 `dev-aaa-first, dev-bbb-second`（持续活动 6s 后仍不变，旧排序会翻）；面板卡片顺序一致、**无 active 徽标**、点选后会话顺序不变；tab 条实测 `["System*","Logs","Network","Storage","Screenshot"]`，默认打开 `pane-info`；Logs pane 底部 `#console` 在 19 条日志之下（input 315×28 + Run 48×28，`bottom` 未超出 pane）；「MCP配置」浮层文本为含 `mcpServers` 的完整 JSON，`position:fixed` 后 `left=272 right=672`（`innerWidth=684`）完整可见。`take_screenshot` 这轮拿不到可见面（内置浏览器页处于 hidden），所以视觉确认只有结构量测，没有像素级复核。
- **Network 列表瘦身 + `type` 分桶（真机+真面板）**：重装插件后本机浏览器与手机两个会话都自动重连。`/api/tool` 侧：12 条列表 6,425B（瘦身前同样会话 100 条是 77,646B 且被截断），逐桶 `xhr/css/js/img/ws/other` 分别回 0/1/2/1/8/0 且 `bucket` 字段正确；面板侧 `dev-944453f8`（手机）Network tab 点「刷新」渲染 11 行无报错，切 6 个桶依次为 `all=11 css=1 js=2 img=1 xhr=1 ws=7 other=1`（总数随 WS 重连增长属正常），点行详情正常显示 status/Request/Response。**发现的环境差异**：`window.fetch` 在 Qoder 内置浏览器（Electron）里没被探针 hook 住（`mockFetch` 的 getter-only 守卫命中，与上游 vConsole 行为一致），真机 Chrome Android 上 fetch 正常进 `xhr` 桶；`XMLHttpRequest` 两处都正常。
- **面板浮层 + Logs 底部复验（真面板 + 进程外假设备 `dev-fake-stream`，每 1.2s 推一条日志）**：连开 3 次采样，`#console` 的 `top/bottom` 恒为 **739/806**（视口 818、pane 底内边距 12），期间日志行数 30→33→35 —— 输入框不再随列表涨缩；`#logs-body` 自己滚（`clientHeight 586`，`scrollHeight` 690→759→805，`scrollTop` 同步贴底 104→173→219）。手动 `scrollTop=0` 往上翻历史后再等 6.4s，`scrollTop` 保持 **0** 未被拽回首屏（`scrollHeight` 仍从 1035 涨到 1150，说明数据在更新）。`#pane-logs` 计算样式 `display:flex` / `overflow:hidden`，其余四个 pane 仍是 `block` + `overflow:auto`（storage pane 实测 top 86 → bottom 818，未受影响）。浮层：真点 `<summary>` 能开能关，`#mcp-conf` 实测 `left=12 right=307 top=47`（`#list` 列右边界 320、header 底 46），高 144px = 9 行无折行，文本仍是含 `mcpServers` 的完整 JSON。收尾：假设备进程已 kill、脚本已删、重启 whistle 后 `sessions: []`，浏览器已切回 demo 页（`dev-aab05b31` online）。回归 27+11+18 全绿，`pnpm build` 绿。
- **`ws_frames` 真页面直连复验（第七轮）**：`pnpm build`（插件 `dist/cli.cjs` 44.3kb / `dist/index.cjs` 43.8kb）→ `w2 stop` → kill 9527/9330 → `w2 install ./whistle.vconsole-0.3.0.tgz` → `w2 start` → 触发 boot。浏览器开 demo 页（会话 `dev-aab05b31` online），`/api/tool` 调 `ws_frames {}` 返回探针自己的 WS 连接帧：`{ frames: [{ wsUrl: "ws://127.0.0.1:9330?sid=dev-aab05b31", seq: 1, type: "send", data: "{\"type\":\"hello\",\"protocol\":1,\"sessionId\":\"dev-aab05b31\",…", nextSince: …, oldestSeq: 0 }` —— 证明「挂在长连接上」时 agent 能拿到该连接上的帧，工具端到端可用。e2e 假探针同时推两条 WS 连接（`ws-conn-a` 带 base64 二进制标记、`ws-conn-b`），stdio 套件 7 条新断言全绿（流式 4 帧 / 二进制 base64 / 按连接 seq / `wsUrl` 过滤 / `sinceFrameTime` 游标 / 无匹配回空）。
- **第二十五轮复验（真面板 + 两台进程外假设备）**：`pnpm build` → `w2 stop` → kill 9527/**9528** → `w2 install whistle.vconsole-0.3.0.tgz` → `w2 start` → 触发 boot，`curl :9527/ | grep -c selectTab` = 3 确认跑的是新代码。两个假设备连 `ws://127.0.0.1:9528`：`dev-hw-tablet`（用户报的华为平板 UA 原文）、`dev-pixel`（普通安卓对照）。结果：`/api/sessions` 与面板卡片标签实测 `DBR-W00 · HarmonyOS · Chrome 132（Browser）` / `Pixel 7 · Android 13 · Chrome 120（Browser）`（修复前前者是 `Chrome 132（Browser）`，设备/系统全丢）。tab 行为实测序列：开 `dev-hw-tablet` → `System / pane-info`；手点 Screenshot → `Screenshot / pane-screenshot`；**切到 `dev-pixel` → `System / pane-info`**（修复前停在 Screenshot）、`d-sid` 已换、`shot-body` 回到占位文案；再点 Storage 后切回 `dev-hw-tablet` 同样回落 System，`#info-body` 渲染 8 行（切会话后数据照拉）。收尾：假设备 kill、脚本删、重启 whistle 后 `sessions: []`。回归 stdio 33 + multi-session 11 + http 23 = **67 全绿**，`pnpm build` 绿（typecheck 通过）。
- **第二十七轮复验（装机 + 真浏览器本地优先截图）**：`pnpm build`（RC=0）→ `w2 stop` → 按坑 20 杀掉残留（这次是 18:08 起的旧 pfork 进程占着 9527/9528，新进程在待机重试，**表现是"代码改了但服务的字节没变"**）→ `w2 install ./whistle.vconsole-0.3.0.tgz`（3.5MB，含 `package/vendor/html2canvas.min.js`）→ `w2 start` → curl 插件 UI 触发 boot。装机侧：`GET :9528/html2canvas.min.js` → 200 / 198,689B / `application/javascript`，sha256 与源文件一致（`e87e5507…`）；`GET :9527/` 面板 HTML 含新文案「优先本地 hub」、旧文案「三个公共 CDN」已消失；`GET :9527/probe.js` md5 == 安装目录文件 md5（`186d654370`）——三个来源字节一致才算真的在跑新包。真浏览器侧（demo 页 `dev-aab05b31` online）：`/api/tool` `screenshot {format:png,scale:0.5}` → `image/png` 105KB，页面 `performance.getEntriesByType('resource')` 里 html2canvas 只有 **`http://localhost:9528/html2canvas.min.js`** 一条、无任何 CDN 请求 → 本地优先链在真页面上生效（修 `bridge.ts` 漏传 `assetUrl` 之前，同一条断言里出现的只有 `fastly.jsdelivr.net`）。回归 **105 全绿**（10+9+37+11+38）。收尾：假设备脚本 `/tmp/simulate-devices.mjs` 与临时探针脚本已删。

## 七、踩过的坑（务必记住）

1. **whistle 插件 tgz 必须自带 node_modules**：`w2 install` 会在包目录跑 `npm install`，公网依赖能装但 `bundleDependencies` 才能保证离线/内网可装（SDK/ws/zod 已列进去）；`npm pack` 会因 `files` 白名单丢掉 node_modules，所以 `build.mjs` 用 `tar` 手工打包。旧版把未发布的 `@bobjoy/vconsole-mcp` 打成 `file:./vendor/*.tgz` 的做法已随合并删除。
2. **MCP `/mcp` 返回 -32700 Parse error**：`StreamableHTTPServerTransport.handleRequest` 需要**已 JSON.parse 过**的 body，传原始 Buffer 会挂。
3. **`list_sessions` 在无会话时误报 "no probe session"**：`handleTool` 里 `resolveSession` 曾在 switch 前无条件调用；已改为仅依赖 session 的工具（get_logs/get_network/wait_for）内部解析。
4. **`select_session` 丢失参数**：mcpServer 注册工具时若把 `sessionId` 从 args 里删掉会破坏 `select_session` 本身——保留 args 原样，同时额外传 `opts`。
5. **multi-session e2e 的 9341 端口残留**：上一次跑挂掉后 hub 没退，下次 A 进程会退化成 proxy、B 反而占住端口，角色互换导致误报。测试已加 preflight 端口占用检查 + fatal 时清理子进程。跑前若挂可 `lsof -ti:9341 | xargs kill`。
6. **zod 版本**：用 3.25.76（3.25.0 没发 dist/）。
7. **console hook 被 Electron 等宿主重包装**：探针有 2s 守卫检测 `__vcmMock` 标记丢失后重新 mock（bridge.ts / log.model.ts）。
8. **同设备多页面互踢**：同指纹新连接 kick 旧连接，旧页面退避、切回标签页自动夺回（probe + hub 双侧实现，勿改坏）。
9. **插件 `rules.txt` 是自动全局生效的**：whistle 在 `lib/plugins/index.js:214` 对每个未禁用插件做 `rulesMgr.append(plugin.rules)`。所以本插件的注入规则随 `w2 start` 直接生效，只能在 whistle 的 Plugins 面板整体关掉；`_rules.txt` 反而只在插件被规则显式启用时才拼进请求规则（不是"隐藏必开"那个用途）。
10. **别用 `jsPrepend` 注入探针**：`jsPrepend` 同时命中 HTML 与 `resType==='JS'` 的响应（`lib/inspectors/res.js:963,1071`），会把 loader 原样拼到每个 .js 文件头上，service worker/worker 里 `window` 未定义会直接抛错。改用 `htmlPrepend`（只作用 HTML），且 `htmlPrepend` 的值**不会**被包 `<script>`（`lib/util/index.js:1379-1387`，只有 `isJsHtml/isCssHtml` 才走 `wrapJs/wrapCss`），所以 `/inject.html` 自己输出完整 `<script>` 标签。
11. **runtime 是首次请求插件 UI 时才 boot**：`w2 start` 后 9528/9527 可能还没监听，先 `curl http://127.0.0.1:8899/whistle.vconsole/`（302 → `:9527` 面板）触发 `exports.uiServer` → `boot()`。
12. **`~/.whistle-vconsole/hub.json` 是共享发现文件**：任何进程起 hub 都会覆写 `{port,lan,updatedAt}`。在临时目录改端口做试跑会把它带偏（本轮踩过：试跑写出 port 19330，真插件随后正常起再覆盖回默认端口）。试跑完删掉 `hub.json` 再让 whistle 起，或确认 `updatedAt` 是最新的。
13. **换包名不会自动顶掉旧插件**：`whistle.vconsole-mcp`（旧）与 `@bobjoy/whistle.vconsole`（新）在 `~/.WhistleAppData/custom_plugins/` 下并存、目录不同（scoped 落在 `@bobjoy/whistle.vconsole`），两边都会去 bind 9528/9527。升级务必先 `w2 uninstall` 旧包。旧包目录已备份在 `~/whistle.vconsole-mcp-0.2.0-plugin-backup.tgz`。
14. **手工 curl `/mcp` 要带 `accept: application/json, text/event-stream`**，否则 SDK 回 406 Not Acceptable。
15. **`lib/runtime.js` 在模块加载时就 `require('../dist/index.cjs')`**：只改 `src/*.ts` 不跑 bundle，whistle 加载插件会直接 MODULE_NOT_FOUND（改动后至少跑 `pnpm --filter @bobjoy/whistle.vconsole bundle`）。`build.mjs` 已加缺产物即抛错的检查。
16. **测试别用 ESM `import` 取 esbuild CJS bundle 的命名导出**：cjs-module-lexer 对 esbuild 的 `__export` 形式识别不可靠，可能只拿到 `default`。`.mjs` 里统一 `createRequire(import.meta.url)('../dist/index.cjs')`。
17. **`lib/panel.js` 是「返回 HTML 字符串的函数」，脚本里的 helper 必须写在模板内部**：`esc()` 曾定义在 Node 模块顶层、被浏览器 `<script>` 里的 20 处调用，页面直接 `ReferenceError: esc is not defined`（面板只剩 `loading…`）。自检：把生成的 HTML 抽出 `<script>` 段落盘跑 `node --check`，再 grep 未定义标识符。
18. **`/api/sessions` 没有 `status` 字段**：它就是把 `list_sessions` 的 `{ sessions: [...] }` 原文回吐。面板判 hub 存活要用 `Array.isArray(d.sessions)`，别再去读一个不存在的握手状态。
19. **面板 2s 轮询不能无条件 `innerHTML=`**：会把鼠标正按着的节点摘掉，点击静默丢失（自动化工具直接报 `Node is detached from document`）。本轮改为比对上一次生成的字符串、变了才写；空态分支记得把缓存清掉，否则恢复列表时不重绘。
20. **whistle 把每个插件 fork 成独立进程（`pfork/lib/main`，命令行里能看到插件名），而 `w2 stop` 不保证带走它**：残留的旧插件进程会继续占着 9528/9527，于是新起的 whistle 里插件永远 `EADDRINUSE`，而且**你看到的还是上一版代码**（本轮就被这个坑了一次：改完重装，面板仍是旧文案）。`boot()` 的 catch 里**绝不能 rethrow**——未处理 rejection 会把进程带走，连先绑上端口的那个进程一起没（现象：端口突然全无人监听，whistle.log 只留 `Error: listen EADDRINUSE`）。现在：探活确认是自己人占着就待机 + 10s 后重试接管。重装后的标准动作：`w2 stop` → `lsof -nP -iTCP:9527 -sTCP:LISTEN -t | xargs kill` → `w2 install` → `w2 start` → `curl http://127.0.0.1:8899/whistle.vconsole/` 触发 boot，再核对 `curl :9527/ | grep <新代码里的串>` 确认跑的是新版。
21. **hub 改成「自建 http server + `new WebSocketServer({ server })`」后，`listen` 失败会同时挂在 wss 实例上**：ws v8 把底层 server 的 `error` 事件镜像给 WebSocketServer，而 `hub.start()` 里 `await listen` 的临时 listener 只在第一次 bind 前存在。没有常驻的 `wss.on('error')` 时，EADDRINUSE 会变成 `Unhandled 'error' event … Emitted 'error' event on WebSocketServer instance`，**CLI 子进程直接崩**，`createBackend()` 的 hub→proxy 降级根本来不及跑（现象：multi-session e2e 报 `MCP error -32000: Connection closed`，看不出根因）。所以 `start()` 里 `wss` 和 `server` 两个对象都要在 `listen` 之前挂上同一个 error listener。
22. **`examples/demo-h5/server.mjs` 启动时把探针 bundle 读进内存**（`const probeCode = fs.readFileSync(...)`）：改完探针只 `pnpm build` 而不重启 9443，页面拿到的还是旧字节，而 `:9527/probe.js` 已经是新的——本轮第一次"本地优先没生效"就是这个假象叠上坑 20（旧 pfork 进程占端口）的双重误导。**复验前先比 md5**：`:9443/vconsole.min.js` / `:9527/probe.js` / `packages/probe/dist/vconsole.min.js` 三者一致才继续。还有：9443 若被更早的实例占着，`nohup … &` 起的新进程会 `EADDRINUSE` 静默死掉（报错只在 `/tmp/demo9443.log` 里），旧进程还在服务旧快照。

## 八、待办 / 建议下一步（按优先级）

1. **真机（手机走 whistle 代理）跑一遍注入**：目前只验到 curl + 本地浏览器（LAN IP 恰好可达）+ 进程外假探针（17 台主流设备模拟，含 HarmonyOS/国产壳/Electron/webview）。手机上重点是探针能否连上 `ws://<lan>:9528`（微信 webview / 代理与 WS 并存）。
2. **发 npm（只剩发布动作，前置检查已做完）**：三个包（`@bobjoy/vconsole` 3.16.0-alpha-mcp.1、`@bobjoy/vconsole-vite` 0.1.0、`@bobjoy/whistle.vconsole` 0.3.0）都已钉 `publishConfig.registry = https://registry.npmjs.org/` + `access: public`（本机默认 registry 是 npmmirror，不钉会发错源）；`examples/demo-h5/index.html` 里的真实 LAN IP 已换成 `location.hostname` + `?ws=` 覆盖。解包扫描：三个 tarball 自有文件无 IP / 无 `` / 无机型串，probe 排除 `*.tsbuildinfo` 并带自己的 LICENSE。**仍需你拍板的四项**：
   - ① probe 与 plugin 的 tarball 里，私有包 `@bobjoy/vconsole-protocol` 被 pnpm 从 `workspace:*` 改写成 `"0.3.0"`——它 `private: true` 永远发不出去，装包时若被当成运行时依赖解析会 404（现在它在 devDependencies，`npm install` 不会拉，所以是「账面幽灵」）。彻底归零的办法：给 webpack/esbuild 加 `resolve.alias` + tsconfig `paths` 直接指 `../protocol/src/protocol.ts`，把这个 devDependency 删掉。
   - ② `packages/vite-plugin` 的 tarball 只有 4 个文件、**没有 LICENSE 也没有 README**。
   - ③ 插件 `package.json` 的 `repository.url` 仍指向 `github.com/Tencent/vConsole`（对 probe 是名副其实的 fork，对插件不是）；根目录也还没有 LICENSE。
   - ④ 若仓库要**公开**（不只是发 npm）：`HANDOFF.md` 与 `.zcode/config.json` 里有 `` 绝对路径，需要扫。
3. **9527 单端口耦合 = 已定边界，不再待办**：一个 server 承载 `/mcp`、`/api/*`、`/`、`/probe.js`、`/inject.html`，hub 端口（9528）兼作静态资源口。结论、成因（`runtime.js` 的 EADDRINUSE 接管、面板与 `/api/tool` 同源、探针资源同源）和三条边界（无鉴权只内网 / URL 只给 LAN IP / 跨网段不做）都写在 `docs/adr/0002-single-http-port-and-no-relay.md`。只有一种情况才需要重开：**手机要经 whistle 代理直接打开面板**（环回 `127.0.0.1:9527` 打不通），那时才把面板/静态资源改由 whistle 自身 serve。
4. **~~协议双副本~~ 已完成**：协议唯一来源是 `packages/protocol/src/protocol.ts`（`private: true`，构建期分别被插件侧 esbuild、探针侧 webpack 内联进 bundle，发布物里不存在这个包名），人工同步双份 `protocol.ts` 的时代结束了；改协议只改这一个文件。细节见第三节与 #15。
5. **~~公网 relay~~ 已搁置**：协议里预留的 proxy 通道（`__mcp_proxy__` + `ApiMsg`）只解决**本机多进程共享一个 hub**，不是远程设备接入通道。做公网 relay 需要额外的运维成本、鉴权、租户隔离，以及「敏感 console/network 数据过第三方服务器」的托管责任，与「零依赖、内网即开即用」的定位冲突——理由与重开条件记在 ADR-002。
6. **MITM 注入**：评估结论走 whistle 插件路线（已落地），自研 MITM 搁置（README 路线图有记录）。

## 九、给接管模型的最小上手路径

1. `pnpm install && pnpm build && pnpm test:e2e`（10+9+37+11+38=105 全绿即环境正常）。
2. `w2 start`，然后 `curl -s http://127.0.0.1:8899/whistle.vconsole/ -o /dev/null` 触发 boot；`curl -s http://127.0.0.1:9527/inject.html` 应输出带当前 LAN IP 的两段 script。
3. `pnpm demo` 起 9443，`curl -s -x 127.0.0.1:8899 http://127.0.0.1:9443/ | head -3` 验注入；浏览器开 demo 页后 `list_sessions` 应见会话。
4. 浏览器开 `http://127.0.0.1:9527/` 走 Drawer 五 tab（System/Logs/Network/Storage/Screenshot，执行 JS 的输入框在 Logs 页底部）。要点：面板必须当顶层页才好点，若手边没真机，可另开一个 Node 进程按 `packages/protocol/src/protocol.ts` 连 `ws://127.0.0.1:9528?sid=xxx` 发 `hello`+`logs`+`network` 并应答 `cmd`（本轮就是这么点验的）。
5. MCP 客户端连 `http://127.0.0.1:9527/mcp`；stdio 回退：`node packages/whistle-plugin/dist/cli.cjs --port 9528`。

关键文件：`packages/whistle-plugin/lib/runtime.js`（注入资源 + MCP HTTP + 面板路由）、`packages/whistle-plugin/rules.txt`、`packages/whistle-plugin/build.mjs`（出包）、`packages/whistle-plugin/src/{index,cli,hub,session,tools,proxyHub,mcpServer}.ts + packages/protocol/src/protocol.ts`（MCP server 本体）、`packages/probe/src/mcp/{bridge,commands}.ts`。
