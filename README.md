# whistle-vconsole

whistle vConsole 插件 + MCP server + H5 页面调试探针。面向 AI agent 的移动端 H5 调试工具，类似 Chrome CDP，但基于 fork 的 [Tencent vConsole](https://github.com/Tencent/vConsole)（dev 分支）实现——让 Claude / Cursor / 任意 MCP 客户端能直接"看到"并"操作"你手机上的 H5 页面。

```
┌──────────────┐  MCP (HTTP/stdio) ┌─────────────────────────┐   WebSocket   ┌──────────────────┐
│  AI Agent    │ ◄───────────────► │ whistle 进程             │ ◄───────────► │ 手机 H5 页面      │
│ (Claude 等)  │     十二个工具     │ @bobjoy/whistle.vconsole │  探针主动连接  │ @bobjoy/vconsole  │
└──────────────┘                   │ hub + /mcp + 设备面板     │               │ 探针（可自动注入） │
                                   └─────────────────────────┘               └──────────────────┘
```

## 组成（monorepo，pnpm workspace）

| 包 | 作用 |
|---|---|
| `@bobjoy/whistle.vconsole` | whistle 插件（主入口）：随 `w2 start` 起 WS Hub、MCP Streamable HTTP、设备面板，并用插件规则自动给被代理页面注入探针。MCP server 源码就在本包 `src/`，其独立 stdio 形态（不用 whistle 时的回退）由同包的 `bin: whistle-vconsole` 提供 |
| `@bobjoy/vconsole` | fork 版 vConsole 探针：面板数据全复用，新增 WebSocket bridge（日志/网络上报 + 命令执行） |
| `@bobjoy/vconsole-vite` | Vite 插件：dev 模式零侵入自动注入探针 |

两端共享的消息协议集中在 `packages/protocol`（`@bobjoy/vconsole-protocol`，`private: true` 的工作区包）：全仓只有 `src/protocol.ts` 一份定义，构建期被插件侧 esbuild、探针侧 webpack 直接内联进各自的单文件 bundle，发布物里不存在这个包（探针的 `dist/vconsole.min.d.ts` 会把它拼成同名 ambient module 块，消费者不需要装它）。

## 快速开始

### 1. 起服务（二选一）

**whistle 插件（推荐，全家桶随 w2 起停）**：

```bash
pnpm --filter @bobjoy/whistle.vconsole build   # 出包 whistle.vconsole-0.3.0.tgz
w2 install whistle.vconsole-0.3.0.tgz
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

（设备面板 `http://127.0.0.1:9527/` 右上角「MCP配置」里就是这份完整 JSON，按当前访问的 host 实时生成，可直接粘。）

**独立 stdio server（不用 whistle 时）**：

```bash
node packages/whistle-plugin/dist/cli.cjs --port 9528
```

启动后会在 stderr 打印局域网地址和探针接入代码片段。

```json
{
  "mcpServers": {
    "vconsole": {
      "command": "node",
      "args": ["/绝对路径/whistle-vconsole/packages/whistle-plugin/dist/cli.cjs", "--port", "9528"]
    }
  }
}
```

### 2. 接入探针（三选一）

**whistle 注入（页面零改动）**：插件自带规则（`packages/whistle-plugin/rules.txt`）

```
* htmlPrepend://http://127.0.0.1:9527/inject.html enable://strictHtml
```

whistle 在开发机本机抓取 `:9527/inject.html`（内含实时局域网地址），把 `<script src="http://<局域网IP>:9527/probe.js">` 加一段 `new VConsole({ serverUrl })` 内联进 HTML 响应。`htmlPrepend` 只改写 HTML，JS/CSS/接口请求不受影响。手机只需能访问开发机的 9527（取探针）和 9528（WS）。规则随插件自动生效，在 whistle 的 Plugins 面板可整体关闭，也可把 `*` 改成具体域名只对目标站点生效。

**npm 包（任意 webview 可用）**：

```bash
pnpm add -D @bobjoy/vconsole
```

```ts
import VConsole from '@bobjoy/vconsole';

new VConsole({
  serverUrl: 'ws://192.168.x.x:9528',   // 运行 hub 的开发机局域网 IP
  // deviceName: 'iPhone 15 测试机',     // 可选标签，不配则由设备指纹自动生成
  // hideUI: true,                       // 纯 agent 调试时隐藏 vConsole 按钮
});
```

**Vite 插件（零代码侵入）**：

```ts
// vite.config.ts
import vconsoleMcp from '@bobjoy/vconsole-vite';

export default defineConfig({
  plugins: [
    vconsoleMcp({
      serverUrl: 'ws://192.168.x.x:9528',
      // hideUI: true,
    }),
  ],
});
```

插件只在 dev 模式注入，不会进生产构建。

### 3. 手机访问

手机与开发机同网段，浏览器/微信 webview 打开页面即可。探针自动连接 server，agent 调用 `list_sessions` 就能看到设备。

## Agent 工具面（12 个）

| 工具 | 说明 |
|---|---|
| `list_sessions` | 列出所有连接的页面（URL/UA/viewport/在线状态），标记活跃会话 |
| `select_session` | 多设备时切换活跃会话 |
| `get_logs` | 拉取 console 日志：level/关键词过滤，`since` 游标增量拉取 |
| `wait_for` | 阻塞等待新的日志/网络请求出现（配合触发动作观察效果） |
| `get_network` | 请求列表：`urlFilter` 过滤、`type` 按类型分桶（`css`/`js`/`img`/`xhr`/`ws`/`other`）、`since` 游标增量；列表行只含摘要（method/url/status/耗时/体积/type），按 `requestId` 才取单条完整详情（headers/body/WS 帧），避免大量请求把结果撑爆 |
| `ws_frames` | 增量拉 WebSocket 帧（send/receive）：`wsUrl` 过滤到单条连接、`sinceFrameTime` 时间戳游标、`limit` 默认 50；返回 `{ frames, nextSince, oldestSeq }`，二进制帧由探针预编码、这里回**纯 base64**（超过 8192 字节只留前 8KB，原始大小在 `totalBytes`），`oldestSeq` 提示 2000 帧环形缓冲溢出。用于"挂在一个长连接上等推送帧到达" |
| `eval_js` | 在页面执行 JS 拿序列化结果（对标 CDP Runtime.evaluate），人机同屏可见 |
| `get_dom` | CSS 选择器查询元素 outerHTML |
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
- **MCP over HTTP**（:9527，stateless Streamable HTTP）：`POST http://127.0.0.1:9527/mcp`，任意支持 http 传输的 MCP 客户端直接接入，12 个工具全量可用，支持 `sessionId` 定向
- **面板 UI**（:9527/）：左侧会话列表按**接入顺序**排列（设备标签/URL/在线状态，1s 自动刷新，不因为选中或活动切换而重排），点击会话在右侧 Drawer 打开 vConsole 式调试面板——System / Logs / Network / Storage / Screenshot（执行 JS 的输入框在 Logs 页底部），与 MCP 工具共用同一套实现；按需求**不含 element 面板**
- **探针资源**（:9527/inject.html、:9527/probe.js）：供插件规则注入使用

**网络边界**：整套只服务**同一局域网**，且**无鉴权**（同网段任何主机都能连 `/mcp`、看面板），绝不要把 9527/9528 暴露到公网或不可信网络；跨网段/公网调试的取舍见 `docs/adr/0002-single-http-port-and-no-relay.md`。

```bash
pnpm --filter @bobjoy/whistle.vconsole build   # 出包 whistle.vconsole-0.3.0.tgz（node_modules 已捆绑，可离线安装）
w2 install whistle.vconsole-0.3.0.tgz
w2 start
```

本仓库 `.zcode/config.json` 默认启用 http 接入、禁用 stdio 回退（`vconsole-stdio`）。

## 工作原理（fork 改了什么）

探针以 vConsole dev 分支（`de7026d`）为基线，**diff 全部是增量**，便于跟上游合并：

- `src/mcp/*`（新增）：bridge 主模块（tap 数据层 + 批量推送 + 断线全量重放）、WS 客户端（指数退避重连）、显示序列化（深度/循环/体积三重防护）、命令实现（eval/dom/storage/page_info/screenshot）、console hook 完整性守卫
- `src/core/core.ts`：+4 行，构造时按 `option.serverUrl` 启动 bridge
- `src/core/options.interface.ts`：+ `mcp?: VConsoleMcpOptions`
- `src/log/log.model.ts`：+2 行，给 console mock 打标（守卫识别第三方事后覆盖 console 的场景，自动重新 hook）
- `src/vconsole.ts`：+1 行，导出类型

数据链路：tap vConsole 的 log store（svelte store 订阅，天然补齐历史）与 `VConsoleNetworkModel.updateRequest`（所有请求类型的唯一汇聚点）→ 探针端环形缓冲 → WS 推送 → server 端按 id 去重 + 游标缓冲 → MCP 工具查询。断线重连时探针全量重放缓冲，server 去重后无损。

## 与 CDP 的差异（诚实声明）

- **网络捕获**基于 JS 层 hook（XHR/fetch/sendBeacon/ResourceTiming），看不到非 JS 发起的请求（如原生层、部分 webview 预请求）
- **截图**是 html2canvas 重绘，canvas/WebGL 内容和部分 CSS 效果会缺失（html2canvas 本身由插件 vendor、优先从 hub 端口加载；https 页面把它当混合内容拦下时退回公网 CDN）
- 需要**页面接入探针**（whistle 注入 / npm 包 / Vite 插件三种方式，见上文），不像 CDP 可以 attach 任意标签页
- 换来的是：**无 USB/adb 依赖**、微信等 webview 可用、同时支持多设备、人类可同屏围观（vConsole UI）

## 开发

```bash
pnpm install
pnpm build          # 构建全部包
pnpm test:e2e       # 回归 105 项：WS 编解码 10 + html2canvas 加载链 9 + stdio 37 + 多会话 11 + MCP-over-HTTP 38（官方 SDK 客户端，覆盖十二工具与 sessionId 定向）
pnpm demo           # 启动演示页 http://localhost:9443
```

## 路线图

- [x] v1：npm 探针 + MCP server 十工具 + 自动化/真实浏览器双 e2e
- [x] v1.x：Vite 插件自动注入
- [x] v2：whistle 插件（设备面板，chii 形态）；探针自动排除自身 WS 连接流量；hub 自动发现（`~/.whistle-vconsole/hub.json`）
- [x] v2.0：MCP server 迁入 whistle 插件（随 `w2 start` 启动：hub + stateless HTTP `/mcp` + 面板 Drawer 调试，除 element 外全量工具）；ZCode 配置迁移到 http 接入
- [x] v2.1：包名收敛为 `@bobjoy/whistle.vconsole` / `@bobjoy/vconsole` / `@bobjoy/vconsole-vite`，协议不再单独发包；插件规则自动注入探针（页面零改动）
- [x] v2.2：`mcp-server` 并入 whistle 插件包（`src/*.ts` → `dist/*.cjs`），stdio 回退用同包 `bin: whistle-vconsole`，仓库只剩三个包
- [x] v2.2+（进行中）：协议收敛为 `packages/protocol` 单一来源（不再人工双副本）；`ws_frames` 增量查看 WS 帧（帧级环形缓冲，二进制由探针预编码 base64）；html2canvas vendor 进插件、探针优先从 hub 端口加载（纯内网可截图）
- [ ] ~~v2.x：公网 relay（远程设备接入）~~ —— 搁置，理由见 `docs/adr/0002-single-http-port-and-no-relay.md`（协议预留的 proxy 通道只服务于本机多进程共享 hub，不是远程接入通道）
- [ ] v2.x：MITM 注入方案（评估结论：whistle 插件路径优先，自研 MITM 搁置——手机侧步骤相同而 whistle 覆盖目标用户群）

## License

MIT。探针包 fork 自 [Tencent/vConsole](https://github.com/Tencent/vConsole)（MIT, Copyright (C) 2017 THL A29 Limited）。
