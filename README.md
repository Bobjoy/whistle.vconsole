# whistle-vconsole

whistle vConsole 插件 + MCP server + H5 页面调试探针。面向 AI agent 的移动端 H5 调试工具，类似 Chrome CDP，但基于 fork 的 [Tencent vConsole](https://github.com/Tencent/vConsole)（dev 分支）实现——让 Claude / Cursor / 任意 MCP 客户端能直接"看到"并"操作"你手机上的 H5 页面。

```
┌──────────────┐  MCP (HTTP/stdio) ┌─────────────────────────┐   WebSocket   ┌──────────────────┐
│  AI Agent    │ ◄───────────────► │ whistle 进程             │ ◄───────────► │ 手机 H5 页面      │
│ (Claude 等)  │     十六个工具     │ @bobjoy/whistle.vconsole │  探针主动连接  │ @bobjoy/vconsole  │
└──────────────┘                   │ hub + /mcp + 设备面板     │               │ 探针（可自动注入） │
                                   └─────────────────────────┘               └──────────────────┘
```

## 组成（monorepo，pnpm workspace）

| 包 | 作用 |
|---|---|
| `@bobjoy/whistle.vconsole` | whistle 插件（主入口）：随 `w2 start` 起 WS Hub、MCP Streamable HTTP、设备面板，并用插件规则自动给被代理页面注入探针。MCP server 源码就在本包 `src/`；不装 whistle 时用同一个包的 `bin: v2` 起 standalone（`v2 start`，HTTP 面与插件完全同源）。包级 README 是 `packages/whistle-plugin/README.md`，npm 页面显示的就是它 |
| `@bobjoy/vconsole` | fork 版 vConsole 探针：面板数据全复用，新增 WebSocket bridge（日志/网络上报 + 命令执行）。**源码不在本仓库**：住在 fork 仓库 [`Bobjoy/vConsole`](https://github.com/Bobjoy/vConsole) 的 `mcp` 分支，本仓库以 git submodule 挂在 `packages/vconsole`；`dev` 分支是 upstream（`Tencent/vConsole`）的纯镜像，只用来同步修复 |
| `@bobjoy/vconsole-vite` | Vite 插件：dev 模式零侵入自动注入探针 |

两端共享的消息协议**两侧各一份副本、都不发包**：Node 侧是 `packages/whistle-plugin/src/protocol.ts`（插件包里的普通源文件，esbuild 和其他模块一起打进 `dist/*.cjs`），探针侧是 fork 里 `src/mcp/protocol.ts`。两份都不是任何包的依赖：插件侧用相对路径直接 import，探针侧的源码写的是 `@bobjoy/vconsole-protocol` 这个名字，由 webpack `resolve.alias` 指回它自己那个本地文件（探针的 `dist/vconsole.min.d.ts` 会把它拼成同名 ambient module 块，消费者不需要装它）。代价是两份会漂，所以两条护栏：改协议必须同一轮动两处；`PROTOCOL_VERSION` 是唯一的握手号，两端不一致时 hub **只标记不断开**（面板与 `list_sessions` 可见）。

## 快速开始

### 1. 起服务（二选一）

两条路解决的不是同一个问题：whistle 插件多出来的价值是**页面零改动**（`rules.txt` 把探针内联进被代理的 HTML，业务代码一行不碰）；独立进程的价值是**不装 whistle 也能把设备接进来**，代价是页面得自己引探针。端口、token、面板、MCP 工具面两边完全一致（同一个 `createHttpService`，见 `docs/adr/0005-standalone-v2-start.md`）。

**按「要不要自动注入」选一条常驻**，别两条都装：`w2 install` 装的那份有自动注入、**不提供全局命令**（它在 whistle 进程里）；`npm i -g` 装的那份给你 `v2` 命令、**不做注入**。两份代码各自独立，版本会漂移——`v2 status` 会把漂移报出来。

**whistle 插件（推荐，全家桶随 w2 起停）**：

```bash
pnpm --filter @bobjoy/whistle.vconsole build   # 仓库根出包，最后一行打印文件名 whistle.vconsole-<版本>.tgz
w2 install whistle.vconsole-<版本>.tgz          # 就是上一步打印的那个名字
w2 start                                       # hub :9528 + MCP/面板 :9527
```

MCP 客户端（ZCode / Claude / Cursor 等）配 http 接入：

```json
{
  "mcpServers": {
    "vconsole": { "type": "http", "url": "http://127.0.0.1:9527/mcp" }
  }
}
```

（设备面板 `http://127.0.0.1:9527/` 右上角「MCP配置」里就是这份完整 JSON，按当前访问的 host 实时生成，点「复制」直接进剪贴板。）

whistle 是**按需 fork 插件进程**的：`w2 start` 之后要先在 whistle 的 Plugins 菜单点一次 `vconsole`（或让一条命中规则的页面过代理），:9527/:9528 才真正起来——在那之前 `v2 status` 会如实报 `stopped`。

**standalone（不装 whistle，全局 `v2` 命令）**：

```bash
npm i -g @bobjoy/whistle.vconsole              # 已发到 npm；验当前代码就装本地包：先 pnpm --filter @bobjoy/whistle.vconsole build，再 npm i -g ./whistle.vconsole-<版本>.tgz
v2 start                                       # 后台守护：hub :9528 + 面板/MCP :9527
```

子命令：`start`（默认后台，`-f` 前台）、`stop`、`status`、`logs [-f]`、`--help`；pid 与日志在 `~/.whistle-vconsole/`（和 `hub.json` 同目录）。`stop` / `status` 只认自己记的那个 pid，不按端口反查杀别人；whistle 插件已经在服务 :9527 时 `v2 start` 直接报错让你用现成的，daemon 先起则插件自己转 proxy 接上（共存）。起服务后 stderr 打印每个网卡的探针端点（含 token），**standalone 不做注入**，页面接入见下面「接入探针」，细节看 `v2 logs`。

MCP 客户端用上面那份 http JSON，一字不差（standalone 和插件服务的是同一个 `/mcp`）。

**备选：不想跑后台服务**——裸跑 `v2` 是 stdio MCP（一个客户端会话一个进程，16 个工具一样全，但没有面板也没有 `/probe.js`；同端口上后起的进程会自动转成 proxy 接上第一个 hub，设备仍然共享）：

```json
{
  "mcpServers": {
    "vconsole": { "command": "v2" }
  }
}
```

要换 hub 端口就加 `"args": ["--port", "9528"]`（`--host` / `--token` 同理，或用环境变量 `WHISTLE_VCONSOLE_PORT` / `WHISTLE_VCONSOLE_HOST` / `WHISTLE_VCONSOLE_TOKEN`）。没装全局命令时，同一个入口是 `node packages/whistle-plugin/dist/cli.cjs`。

### 2. 接入探针（按形态选一种）

**whistle 注入（页面零改动）**：插件自带规则（`packages/whistle-plugin/rules.txt`）

```
* htmlPrepend://http://127.0.0.1:9527/inject.html enable://strictHtml
```

whistle 在开发机本机抓取 `:9527/inject.html`（内含实时局域网地址和接入 token），把 `<script src="http://<局域网IP>:9527/probe.js">` 加一段 `new VConsole({ serverUrl })` 内联进 HTML 响应。`htmlPrepend` 只改写 HTML，JS/CSS/接口请求不受影响。手机只需能访问开发机的 9527（取探针）和 9528（WS）。规则随插件自动生效，在 whistle 的 Plugins 面板可整体关闭，也可把 `*` 改成具体域名只对目标站点生效。**这条路径不需要你手工带 token**——注入片段里已经带好。

**standalone 外链（不装 whistle，页面也不想装包）**：探针 js 就挂在 HTTP 面上，页面自己引，`v2` 不会替你改写 HTML：

```html
<script src="http://<局域网IP>:9527/probe.js"></script>
<script>
  new VConsole({ serverUrl: 'ws://<局域网IP>:9528?t=<token>' });
</script>
```

同网段 http 页面这样就能连上。但 **https 页面里的 `ws://` 会被浏览器当混合内容拦掉**，只能前面自己架一条 TLS 隧道（frp / cloudflared / nps 之类），`serverUrl` 写成 `wss://<隧道域名>/?t=<token>`，隧道另一端是本机 9528（为什么不做 relay 见 `docs/adr/0002-single-http-port-and-no-relay.md`）。`examples/demo-h5/cdn.html` 是这条路径现成的可运行验证页（`?ws=` 直接覆盖 `serverUrl`）。

**npm 包（任意 webview 可用）**：

```bash
pnpm add -D @bobjoy/vconsole
```

```ts
import VConsole from '@bobjoy/vconsole';

new VConsole({
  // 局域网 IP + 接入 token（hub 启动时在 stderr 打印成可直接粘贴的整串）
  serverUrl: 'ws://192.168.x.x:9528?t=<token>',
  // deviceName: 'iPhone 15 测试机',     // 可选标签，不配则由设备指纹自动生成
  // hideUI: true,                       // 纯 agent 调试时隐藏 vConsole 按钮
});
```

**公网 CDN 外链（页面已发布到公网时）**：探针是单文件 UMD、全局 `VConsole`、依赖已全部打进 bundle，外联可直接用，不需要装包也不需要构建（`@bobjoy/vconsole` 已发到 npm，下面的 unpkg 地址就是现成的）：

```html
<script src="https://unpkg.com/@bobjoy/vconsole@3.16.3/dist/vconsole.min.js"></script>
<script>
  new VConsole({ serverUrl: 'wss://<你的隧道域名>/?t=<token>' });
</script>
```

`examples/demo-h5/cdn.html` 就是这份代码的可运行版本（`?ws=` 覆盖 serverUrl）。**能公网外链的只有探针 js，回程仍然是 hub**：https 页面只能连 `wss://`（`ws://` 会被浏览器当混合内容拦掉），而 hub 只监听明文 WS、也没有 relay（取舍见 `docs/adr/0002-single-http-port-and-no-relay.md`）。所以公网页面的现实形态是：js 走 CDN，`serverUrl` 指向你自己前置的 TLS 隧道（frp / cloudflared / nps 之类），隧道另一端是本机 9528。

**Vite 插件（零代码侵入）**：

```ts
// vite.config.ts
import vconsoleMcp from '@bobjoy/vconsole-vite';

export default defineConfig({
  plugins: [
    vconsoleMcp({
      serverUrl: 'ws://192.168.x.x:9528?t=<token>',
      // hideUI: true,
    }),
  ],
});
```

插件只在 dev 模式注入，不会进生产构建。

### 3. 手机访问

手机与开发机同网段，浏览器/微信 webview 打开页面即可。探针自动连接 server，agent 调用 `list_sessions` 就能看到设备。

## Agent 工具面（16 个）

| 工具 | 说明 |
|---|---|
| `list_sessions` | 列出所有连接的页面（URL/UA/viewport/在线状态），标记活跃会话 |
| `select_session` | 多设备时切换活跃会话 |
| `get_logs` | 拉取 console 日志：level/关键词过滤，`since` 游标增量拉取 |
| `wait_for` | 阻塞等待新的日志/网络请求出现（配合触发动作观察效果） |
| `get_network` | 请求列表：`urlFilter` 过滤、`type` 按类型分桶（`css`/`js`/`img`/`xhr`/`ws`/`other`）、`since` 游标增量；列表行只含摘要（method/url/status/耗时/体积/type），按 `requestId` 才取单条完整详情（headers/body/WS 帧），避免大量请求把结果撑爆 |
| `ws_frames` | 增量拉 WebSocket 帧（send/receive）：`wsUrl` 过滤到单条连接、`sinceFrameTime` 时间戳游标、`limit` 默认 50；返回 `{ frames, nextSince, oldestSeq }`，二进制帧由探针预编码、这里回**纯 base64**（超过 8192 字节只留前 8KB，原始大小在 `totalBytes`），`oldestSeq` 提示 2000 帧环形缓冲溢出。用于"挂在一个长连接上等推送帧到达" |
| `replay_request` | 把 `get_network` 里的某条记录**原样**再发一次，拿这次的响应：由页面自己用 `fetch` 发出，所以 cookie / referer 自动带上、whistle 代理规则照旧生效、这一次也会成为一条新记录（`replayedFrom` 指回原请求）。只放 `xhr`/`fetch`；`POST`/`PUT`/`PATCH`/`DELETE` 必须显式 `allowUnsafe: true`；`body` 只回前 8KB（`truncated`/`responseSize` 说明真实大小），完整响应用 `get_network({ requestId: replayedId })` 取；抓包时已被格式化成 `[object Blob]` 的请求体直接拒绝，不假装能还原 |
| `eval_js` | 在页面执行 JS 拿序列化结果（对标 CDP Runtime.evaluate），人机同屏可见 |
| `get_dom` | CSS 选择器查询元素 outerHTML |
| `get_vue_tree` | Vue 组件树（Vue 2 / Vue 3 都认）：不带 `app` 列出页面里的应用（名字、挂载容器、`readable`——Vue 3 的组件树只有开发构建页面可读，Vue 2 生产页面也能看），带 `app` + `path`（形如 `"0.1"`）展开一层子组件；子项多时返回 `next` 作为下一页的 `offset`，`limit` 默认 12、最大 20。跑的是面板 Vue 标签那份序列化器，经 `eval_js` 下发，老探针也能用 |
| `get_vue_state` | 读单个组件的状态 JSON：`props` / `setup`（ref 已解包）/ `data` / `computed`（真的求值）/ `$route` 摘要 / Pinia store / Vuex state + getters，页面没有的段返回 `null`；有深度与体积预算，整体约 20000 字符封顶 |
| `set_vue_state` | 按点路径写回一个值（devtools 手感）：`section` 取 `data`/`setup`/`vuex`/`pinia`，`key` 是相对它的路径（`appTitle`、`form.name`、`items.0.done`；`pinia` 的第一段是 store id，`vuex` 直写 `$store.state`、绕过 mutation 记录）；`props`/`computed` 拒写（它们由父级或派生决定）。写入是响应式的，页面 UI 跟着变 |
| `get_storage` | 读 cookies / localStorage / sessionStorage |
| `set_storage` | 写单条：`storage`(local/session/cookie) + `key` + `value`，返回页面写入后的真实值（HttpOnly cookie 写不进会明确报错） |
| `get_page_info` | URL/UA/viewport/JS 堆内存/导航计时（TTFB、DOMContentLoaded、load） |
| `screenshot` | html2canvas 截图，返回 MCP image block（对 canvas/WebGL 页面不完整）；html2canvas 随插件 vendor，探针优先从 hub 端口取，公网 CDN 仅兜底 |

## 会话与设备

- **sessionId = 设备指纹**：探针用 `UA + 平台 + 屏幕尺寸 + 触点数` 计算指纹（`dev-<hash8>`），同一台设备的所有页面共享一个会话，`list_sessions` 一眼区分设备；页面刷新后 sessionId 不变，历史缓冲自动衔接。
- **deviceLabel**：server 从 UA 解析出可读标签，布局为 **设备 · 系统 · 内核 版本（容器/产品）**，括号里的产品版本只取主版本、次版本非 0 才带上（`Edge 154`、`SamsungBrowser 29`、`MQQBrowser 14.3`），例如 `iPhone · iOS 16.0 · App WeChat 8.0`、`Pixel 7 · Android 13 · Chrome 120`、`SM-S938B · Android 15 · Chrome 150（SamsungBrowser 29）`。括号只在系统段看不出来时才写（App/微信外壳、Chrome 内核套壳的产品名），PC/Browser 这类泛分类不显示；配合自定义 `deviceName` 展示。安卓 Chromium 的 UA 冻结机制会把机型显示为占位符 "K"（版本冻结为 10）；探针自动通过 Client Hints（`userAgentData.getHighEntropyValues`）取真机型填入 `deviceName`，面板显示为 `K · Android 10 · Chrome 153 (M2012K11AC · Android 13 153)`（卡片里 `.dev` 与 `.muted` 只留一份浏览器信息：有 `deviceName` 时括号里的产品名让位给 `deviceName`，版本号搬到后面；MCP `list_sessions` 返回的 `deviceLabel` 始终带完整括号段），旧内核 webview 无此 API 时静默回退 UA 解析。
- **同设备多页面**：新页面连接会 kick 旧页面，旧页面自动退让（停止重连），用户切回那个标签页时自动恢复重连并夺回会话——永远是"当前可见的页面"在调试。
- 初始化时可传 `deviceName` 覆盖自动标签。

## whistle 插件形态（`@bobjoy/whistle.vconsole`）

whistle.chii 风格插件，把 **MCP server、设备面板和探针注入一起搬进了 whistle 进程**——`w2 start` 即启动，`w2 stop` 即关闭，不需要单独的 hub node 进程。

- **WS Hub**（:9528）：探针连接点，随 w2 起停。同一个端口兼作静态资源（`GET /html2canvas.min.js`），截图用的 html2canvas 由插件 vendor，探针优先从这个它本来就连得上的源加载——纯内网无 CDN 也能截图
- **MCP over HTTP**（:9527，stateless Streamable HTTP）：`POST http://127.0.0.1:9527/mcp`，任意支持 http 传输的 MCP 客户端直接接入，16 个工具全量可用，支持 `sessionId` 定向
- **面板 UI**（:9527/）：左侧会话列表按**接入顺序**排列（设备标签/URL/在线状态，1s 自动刷新，不因为选中或活动切换而重排），点击会话在右侧 Drawer 打开 vConsole 式调试面板——System / Logs / Network / Element / Vue / Storage / Screenshot（执行 JS 的输入框在 Logs 页底部），与 MCP 工具共用同一套实现；Network 详情区带「原样再发一次」，非幂等方法会先弹一次确认。Element 与 Vue 两个标签是 eval 驱动的：序列化器随面板下发、在页面上现跑，所以对**已发布的每一版探针**都可用，不需要探针升级
- **探针资源**（:9527/inject.html、:9527/probe.js）：供插件规则注入使用

**网络边界**：整套只服务**同一局域网**。接入规则是一条：**回环免鉴权，非回环必须带 `?t=<token>`**（`docs/adr/0004-loopback-free-non-loopback-token.md`）——hub 启动时生成 token、写进 `~/.whistle-vconsole/hub.json`、并在 stderr 打印成可直接粘贴的 `ws://<lan>:9528?t=...`；whistle 注入路径自动带好，本机面板/MCP 客户端不需要它，从局域网打开面板要在 URL 上补 `?t=`。它挡住的是"读不到我们 HTTP 响应"的对端（别的机器上的网页可以直接发 `ws://192.168.x.x:9528`，因为 WebSocket 不受 CORS 约束），**不挡住能自由 curl 你端口的主机**——探针 js 与注入片段必须公开可取，同网段视为可信这条从 ADR-002 起没变。绝不要把 9527/9528 暴露到公网或不可信网络；跨网段/公网调试的取舍见 `docs/adr/0002-single-http-port-and-no-relay.md`。

```bash
pnpm --filter @bobjoy/whistle.vconsole build   # 出包 whistle.vconsole-<版本>.tgz（node_modules 已捆绑，可离线安装）
w2 install whistle.vconsole-<版本>.tgz
w2 start
```

MCP 客户端的两种接法，一份可以直接粘的配置（`<workspace>` 换成你在磁盘上的仓库路径；`enabled: false` 那条是「不装 whistle 时的备选」，同时开着会让两个进程抢 9528）：

```json
{
  "mcp": {
    "servers": {
      "vconsole": {
        "type": "http",
        "url": "http://127.0.0.1:9527/mcp",
        "enabled": true,
        "_comment": "由 @bobjoy/whistle.vconsole 插件提供，随 w2 start 起停；需要 whistle 在跑（hub 在 ws 9528，MCP http 在 9527）"
      },
      "vconsole-stdio": {
        "type": "stdio",
        "command": "node",
        "args": ["<workspace>/packages/whistle-plugin/dist/cli.cjs", "--port", "9528"],
        "enabled": false,
        "_comment": "standalone 直连：agent 自己起一个进程，没有面板也没有 /probe.js"
      }
    }
  }
}
```

## 工作原理（fork 改了什么）

探针以 vConsole dev 分支（`de7026d`）为基线，**diff 全部是增量**，便于跟上游合并：

- `src/mcp/*`（新增，合计约 1680 行）：`bridge.ts` 主模块（tap 数据层 + 批量推送 + 断线全量重放）、`wsClient.ts` WS 客户端（指数退避重连）、`serialize.ts` 显示序列化（深度/循环/体积三重防护）、`commands.ts` 命令实现（eval/dom/storage/page_info/screenshot/replay，重放直接读页面内的原始请求项，不依赖回传的序列化文本）、`replayStamp.ts`（重放在 `fetch()` 前一 tick 打的那半个标记）、`protocol.ts`（协议副本）
- `src/network/wsCodec.ts`：+80 行，二进制帧预编码成 base64（超过 8192 字节只编前 8KB，尾部追加 `:原始字节数`）；`src/network/websocket.proxy.ts`：+10 −1，收发两侧都过它，Blob 读到字节后回头改写那条帧
- `src/core/core.ts`：+15 行，构造时按 `option.serverUrl` 尽早起 bridge，不等面板打开才开始收集
- `src/core/options.interface.ts`：+15 行，五个新选项——`serverUrl` / `deviceName` / `autoConnect` / `hideUI` / `maxBuffer`
- `src/log/log.model.ts`：+5 −1，给 console mock 打标（守卫据此识别第三方事后覆盖 console 的场景，自动重新 hook）
- `src/network/fetch.proxy.ts`：+37 −2、`src/network/network.model.ts`：+24 −7 —— 两件事：重放出来的请求在自己那条记录上标 `replayedFrom`（代理同步取走标记，不按 URL 猜）；fetch 看门狗，第三方事后重新赋值 `window.fetch`（或初始化时它是个 getter）也会被补挂，包装链保留不断
- `src/network/requestItem.ts`：+1 行（`replayedFrom` 字段）、`src/vconsole.ts`：+1 行（导出类型）

数据链路：tap vConsole 的 log store（svelte store 订阅，天然补齐历史）与 `VConsoleNetworkModel.updateRequest`（所有请求类型的唯一汇聚点）→ 探针端环形缓冲 → WS 推送 → server 端按 id 去重 + 游标缓冲 → MCP 工具查询。断线重连时探针全量重放缓冲，server 去重后无损。

## 与 CDP 的差异（诚实声明）

- **网络捕获**基于 JS 层 hook（XHR/fetch/sendBeacon/ResourceTiming），看不到非 JS 发起的请求（如原生层、部分 webview 预请求）
- **截图**是 html2canvas 重绘，canvas/WebGL 内容和部分 CSS 效果会缺失（html2canvas 本身由插件 vendor、优先从 hub 端口加载；https 页面把它当混合内容拦下时退回公网 CDN）
- 需要**页面接入探针**（whistle 注入 / npm 包 / Vite 插件三种方式，见上文），不像 CDP 可以 attach 任意标签页
- 换来的是：**无 USB/adb 依赖**、微信等 webview 可用、同时支持多设备、人类可同屏围观（vConsole UI）

## 开发

```bash
git clone --recursive https://github.com/Bobjoy/whistle.vconsole.git   # 探针是 submodule，漏了 --recursive 就 `git submodule update --init`
pnpm install
pnpm build          # 构建全部包（含 packages/vconsole）
pnpm test:e2e       # 回归 202 项：stdio 50 + 多会话 11 + MCP-over-HTTP 59 + `v2` CLI 进程面 82（start/stop/status/logs、端口共存、发布面）
pnpm demo           # 启动演示页 http://localhost:9443
```

探针侧的 40 项单测（WS 编解码 10 + html2canvas 加载链 9 + 页面侧重放 21）跟着探针源码走，在探针仓库里跑 `npm test`，不在本仓库。

三个容易踩的操作点：

- 发布探针前单独跑一次 `pnpm --filter @bobjoy/vconsole build:typings`（`pnpm build` 不含它，否则 `dist/vconsole.min.d.ts` 是旧的）。
- 跑 `pnpm test:e2e` 前先 `v2 stop`（whistle 插件在跑也要停）：最后那段 `cli.e2e` 要独占 9527，端口被占着它会带着提示直接退出，前三段的结果也就不完整。
- 复验装机效果前先确认没有残留进程：whistle 把插件 fork 成独立进程，`w2 stop` 不保证带走它，残留进程会占着 9527/9528 继续吐旧字节；`examples/demo-h5/server.mjs` 又在启动时把探针 bundle 读进内存。比一下 `:9527/probe.js`、`:9443/vconsole.min.js` 和磁盘上 `dist/vconsole.min.js` 的 md5，一致才说明你验的是当前代码。

## 路线图

- [x] v1：npm 探针 + MCP server 十工具 + 自动化/真实浏览器双 e2e
- [x] v1.x：Vite 插件自动注入
- [x] v2：whistle 插件（设备面板，chii 形态）；探针自动排除自身 WS 连接流量；hub 自动发现（`~/.whistle-vconsole/hub.json`）
- [x] v2.0：MCP server 迁入 whistle 插件（随 `w2 start` 启动：hub + stateless HTTP `/mcp` + 面板 Drawer 调试，除 element 外全量工具）；ZCode 配置迁移到 http 接入
- [x] v2.1：包名收敛为 `@bobjoy/whistle.vconsole` / `@bobjoy/vconsole` / `@bobjoy/vconsole-vite`，协议不再单独发包；插件规则自动注入探针（页面零改动）
- [x] v2.2：`mcp-server` 并入 whistle 插件包（`src/*.ts` → `dist/*.cjs`），stdio 回退用同一个包的 `bin`（v0.3.0 起这个命令叫 `v2`），仓库只剩三个包
- [x] v2.2+（进行中）：协议先收敛为 `packages/protocol` 单一来源，量完跨仓库代价后翻案成两侧各一份内联副本（ADR-0007/0008）；`ws_frames` 增量查看 WS 帧（帧级环形缓冲，二进制由探针预编码 base64）；html2canvas vendor 进插件、探针优先从 hub 端口加载（纯内网可截图）
- [x] v2.2+（发布清账）：私有协议包先做到**不作依赖**（webpack `resolve.alias` + tsconfig `paths` 构建期内联，pnpm 不再把它改写成装不出的范围），随后那个壳整个撤掉——Node 侧那份并成 `packages/whistle-plugin/src/protocol.ts`（相对 import，`paths` 随之删除），探针侧继续用自己的 `src/mcp/protocol.ts`；`@bobjoy/vconsole-vite` 补 LICENSE + README；仓库根补 LICENSE；删掉插件里指向 Tencent/vConsole 的假 `repository`
 - [x] v2.2+（Vue 面板）：远程抽屉新增 Vue 标签——eval_js 驱动的组件树 + 状态查看与复制，**Vue 2 / Vue 3 双支持**：Vue 3 走 `__vue_app__`（组件树仅开发构建页面可读，生产页明确提示），Vue 2 走 `__vue__`（生产构建也暴露实例，线上线下都能看）；状态含 **computed 求值、`$route` 摘要、Pinia store（`$pinia._s`）**；**状态回写**：详情区「编辑」按 `data.xxx.y / setup.xxx` 点路径写入 JSON 值（props/computed 拒写），SSE 活动驱动的节流自动刷新（编辑中不打扰）；根节点带 v2/v3 徽标；demo 加 `vue.html`（Vue 3 dev 构建）与 `vue2.html`（Vue 2.7 生产构建）
 - [x] v2.2+（Element 面板）：远程抽屉新增 Element 标签——eval_js 驱动的懒展开 DOM 树（序列化在页面上实时执行，单响应 ≤1800 字符自动分页）+ outerHTML 详情与复制，零协议变更、对全部已发布探针立即可用；正式协议命令化待需求验证后评估
 - [x] v2.2+（请求重放）：`replay_request` 把 Network 里抓到的请求在**页面内**原样再发一次（走同源 cookie/签名/代理规则），响应新状态、8KB 截断、新记录带 `replayedFrom`；非幂等方法由显式 `allowUnsafe` 把关，面板详情区同一颗按钮先弹确认；不可重放的（图片/script 等资源类请求、`[object Blob]` 占位请求体）直接拒绝而不是降级。见 `docs/adr/0003-page-side-replay.md`、`docs/specs/2026-10-05-network-replay.md`
- [x] v2.2+（standalone）：HTTP 面上移成 `src/httpService.ts`，插件与 `v2 start` 共用一份实现；全局命令收成 `v2`（`start`/`-f`/`stop`/`status`/`logs`，裸跑仍是 stdio MCP），与 whistle 插件同端口共存、`status` 报版本漂移。见 `docs/adr/0005-standalone-v2-start.md`
- [x] v2.2+（发包与开源面）：三个包全部发到公网 npm（`@bobjoy/whistle.vconsole` / `@bobjoy/vconsole` / `@bobjoy/vconsole-vite`，版本号以各包 `package.json` 为准），unpkg 外链接可用；仓库转到 [`Bobjoy/whistle.vconsole`](https://github.com/Bobjoy/whistle.vconsole)（public），探针 fork 在 [`Bobjoy/vConsole`](https://github.com/Bobjoy/vConsole) 的 `mcp` 分支
- [ ] 真机复验：手机走 whistle 代理，重点验探针能否连上 `ws://<开发机 LAN IP>:9528`（微信 webview、代理与 WS 并存）。目前只验到本地浏览器 + 进程外假探针，设备多样性靠 e2e 里那 17 条 UA/卡片标签断言覆盖，真机品牌行为没验过
- [ ] ~~v2.x：公网 relay（远程设备接入）~~ —— 搁置，理由见 `docs/adr/0002-single-http-port-and-no-relay.md`（协议预留的 proxy 通道只服务于本机多进程共享 hub，不是远程接入通道）
- [ ] v2.x：MITM 注入方案（评估结论：whistle 插件路径优先，自研 MITM 搁置——手机侧步骤相同而 whistle 覆盖目标用户群）

## License

MIT。探针包 fork 自 [Tencent/vConsole](https://github.com/Tencent/vConsole)（MIT, Copyright (C) 2017 THL A29 Limited）。
