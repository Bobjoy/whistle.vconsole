# 规格说明书：standalone `v2` 守护服务（与 whistle 插件共存）

日期：2026-10-06　关联：ADR-005（本规格的全部不可逆决策）、ADR-002（单端口/不做 relay）、ADR-004（回环免 token）、`CONTEXT.md#启动形态`

## 1. 问题陈述

hub、设备面板、MCP-over-HTTP、`/probe.js`、`/inject.html`、SSE 变更通知、token 网关全部写在 `packages/whistle-plugin/lib/runtime.js`，只有 whistle 的 `uiServer` 钩子会调 `boot()`。后果：

- 不用 whistle 就没有面板、没有 MCP-over-HTTP、没有探针资源口——尽管这些**一个 whistle API 都没调**（`runtime.js` 里只有自建 `http.createServer`）。
- 唯一的独立入口 `dist/cli.cjs` 只起 stdio MCP，看不到设备面板，也没法让多个 agent 会话共享一个 hub。
- `npm i -g @bobjoy/whistle.vconsole` 装出来的 `v2` 命令因此只能当 MCP 客户端的 `command`，不能当服务用；想常驻调试就得装 whistle。

## 2. 方案概述

把 `runtime.js` 的 HTTP 面**原样上移**到 `src/httpService.ts`，导出一个 `createHttpService(...)`；whistle 的 `lib/runtime.js` 和 CLI 的 `v2 start` 各自调它，一份实现两个入口。CLI 补子命令：`start`（默认后台 detached）/ `stop` / `status` / `logs`，`-f` 前台；裸跑 `v2` 仍是 stdio MCP，行为不变。whistle 插件路径行为零变化，pfork 自愈逻辑留在 `lib/runtime.js` 不下沉。

```
src/index.ts ── createBackend() ─┐
                                 ├─→ src/httpService.ts（面板 + /mcp + /api/* + /probe.js + /inject.html + SSE + token 网关）
lib/runtime.js（whistle 触发 + pfork 自愈）─┤
src/cli.ts  ── v2 start|stop|status|logs|-f ─┘
```

## 3. 用户故事

### 起服务

1. **前台起 standalone**：`v2 start -f` 在同一进程起 hub(:9528) + HTTP 面(:9527)，stderr 打印面板 URL、MCP url、每个网卡的探针端点（含 `?t=`）、以及「standalone 没有自动注入，页面需自己引探针」一行。验证：Ctrl-C 后两个端口都不再应答。
2. **后台起 standalone**：`v2 start` 打印面板 URL 与「`v2 logs` 看日志」后退出 0；服务继续在后台跑。验证：`curl 127.0.0.1:9527/api/sessions` 返回 200 且含 `"sessions"`；父 shell 已返回提示符。
3. **就绪判定不靠 sleep**：`v2 start` 只在 :9527 真正应答后才报成功；起不来就把日志尾部贴回 stderr 并以非 0 退出。验证：故意让 9528 被一个非 hub 进程占住 → `start` 失败退出且日志里能看到原因。
4. **`start` 幂等**：已在跑时 `v2 start` 不产生第二个进程，打印当前状态并退 0。验证：连跑两次 `v2 start`，`v2 status` 只有一个 pid，`ps` 里只有一个 daemon。
5. **端口参数一致生效**：`--port/--host/--token` 对 `start`、`start -f` 和裸 stdio 三种入口同样有效。验证：`v2 start --port 9700 -f` 后 `~/.whistle-vconsole/hub.json` 的 `port` 是 9700。

### 停与看

6. **`v2 stop` 只杀自己记的 pid**：读 `~/.whistle-vconsole/v2.pid` 并 SIGTERM，等端口释放（上限 3s），然后删 pid 文件。验证：停完 `curl :9527` 拒连。
7. **`stop` 不越权**：pid 文件缺失/已死而 :9527 仍有人应答时，`stop` 明确报「这个端口不是 v2 daemon 在服务（可能是 whistle 插件）」且不动任何进程。验证：只跑 `w2 start` 时执行 `v2 stop`，whistle 进程 pid 不变、面板仍可访问。
8. **`v2 status` 报 owner**：三种状态可区分——`daemon`（pid 活 + 端口应答）/ `in-plugin`（端口应答但 pid 不对）/ `stopped`（都无）。输出含面板 URL、探针端点（LAN ip + 端口，**不含 token**，指向 `v2 logs`）。验证：分别在三态下跑，输出匹配。
9. **`status` 报版本漂移**：同时装了插件（`~/.WhistleAppData/custom_plugins/@bobjoy/whistle.vconsole/node_modules/@bobjoy/whistle.vconsole`）和全局包时，两个 `version` 不一致就打印提示。验证：手工把插件目录里的 `package.json` version 改成别的值，`status` 出现提示行。
10. **`v2 logs`**：默认尾 200 行，`-f` 跟随（Ctrl-C 只退出 tail，不停服务）。验证：`start` 后触发一条探针日志，`logs` 里出现。

### 撞口与共存

11. **撞 9527 就报错退出**：`v2 start` 绑不上 :9527 且对端答得像自家面板时，退出非 0 并提示「whistle 插件已在服务，直接用 `http://127.0.0.1:9527`」。验证：`w2 start` 后跑 `v2 start`，无新进程、无 pid 文件。
12. **反方向自动共存**：daemon 先起，再 `w2 start` → 插件的 `createBackend` 撞 :9528 转 proxy 模式，并从 `hub.json` 读到**同一个 token**，注入与面板继续可用。验证：`w2 start` 后打开面板能看到 daemon 侧已连的设备；`/inject.html` 返回的 `serverUrl` 里 token 与 `hub.json` 一致。
13. **不新增端口**：standalone 仍只用 :9527 + :9528，探针资源口（:9528 的 `GET /html2canvas.min.js`）行为不变。验证：`curl 127.0.0.1:9528/html2canvas.min.js` 返回 200。

### 接入与文档

14. **standalone 页面接入走外链**：README 明确「npm/CDN 外链」或 `http://<lan>:9527/probe.js`，并说明 https 页面必须 `wss://` 隧道（ADR-004）。验证：`examples/demo-h5/cdn.html` 在 `?ws=ws://<lan>:9528?t=<token>` 下能连上 daemon。
15. **MCP 配置示例改 `v2`**：README 的 stdio 示例从 `command: "node" + 绝对路径` 改成 `command: "v2"`；standalone 章节主推 `{"type":"http","url":"http://127.0.0.1:9527/mcp"}`，stdio 标为「不想跑后台服务」的备选。验证：按 README 抄一份配置能连上。
16. **两条安装路径分工写清**：README 说明 `w2 install`（有自动注入、无全局命令）与 `npm i -g`（有 `v2`、无注入）各装一份代码，只按「要不要自动注入」选一条常驻。
17. **`v2 --help` 覆盖全部子命令**：help 文本含 `start/-f/stop/status/logs`、端口与 token 的环境变量、以及 stdio 默认行为。验证：`v2 --help` 输出与 README 一致不矛盾。

## 4. 已定决策（不再翻案，理由见 ADR-005）

- 共存而非替代；HTTP 面上移共用；whistle 路径零变化；pfork 自愈留 `lib/runtime.js`。
- 唯一 bin 名 `v2`，不留别名；裸跑 = stdio MCP。
- `start` 默认后台 detached，`-f` 前台；`stop` / `status` / `logs` 齐备；**不做 `restart`**。
- pid 与日志进 `~/.whistle-vconsole/`（与 `hub.json` 同目录）：`v2.pid`、`v2.log`，追加不轮转。
- :9527 单 owner：撞口报错退出，不接管、不加 `--http-port`。
- `stop` 只认 pid 文件；`status` 不回显 token。
- standalone 不做 HTML 注入、不打印 `<script>` 接入片段；不做 launchd 自启、不做 `uninstall`。
- 一个发布物（`@bobjoy/whistle.vconsole`）承载两条安装路径，靠 `status` 报版本漂移，不拆 cli 包。

## 5. 测试决策

**主接缝 = CLI 进程边界**（最高、最稳）：断言 exit code、pid/日志文件、:9527/:9528 的实际应答。复用现有 harness 的 spawn 方式（`test/e2e.mjs`、`test/http.e2e.mjs` 都是 `process.execPath` + `dist/cli.cjs`），新增 `test/cli.e2e.mjs` 覆盖故事 1-12。要点：

- 每个 case 用**独立端口**（9300+ 段，避开 9527/9528 和测试既用的 9343/9528），并显式传 `--token`，别污染 `~/.whistle-vconsole/hub.json` 与 `v2.pid`（测试用 `HOME` 指向临时目录来隔离这两个文件）。
- daemon 类断言必须走真实进程 + 真实 socket，不做假 pid。

**次接缝 = `createHttpService(cfg)`**：现有 `test/http.e2e.mjs` 在 92 行起「same wiring as lib/runtime.js」手写了一遍 http server —— 这正是重复实现的证据。改造它改成调用 `createHttpService`，于是同一批 47 项检查同时成为「插件与 standalone 同源」的证明，不新增测试。

**纯函数不动**：`hasAccess` / `isLoopback` 仍按 ADR-004 在 `http.e2e.mjs` 开头单点断言一次。

**「完成」的定义**：`pnpm build` 绿；`pnpm test:e2e` 全绿（现 148 项 + 新 CLI 套件）；真链路复验一遍——`v2 start` 后台起、手机或假设备连上、面板看得到、`v2 stop` 干净退出，然后 `w2 start` 走插件路径确认行为与改动前一致（md5 对齐 `:9527/probe.js` 与 `packages/probe/dist/vconsole.min.js`）。

## 6. 明确不做

- 不给 standalone 做 HTML 注入 / 极简代理 / relay（ADR-002）。
- 不做 `restart`、`uninstall`、launchd/systemd 自启、日志轮转、`--http-port`。
- 不改 hub 协议、探针、面板 UI、工具面；不改 token 规则（ADR-004）。
- 不拆包、不改包名、不改 `@bobjoy/whistle.vconsole` 的 whistle 插件身份。
- 不改 :9527/:9528 的默认值。

## 7. 补充说明

- **搬移的边界要干净**：`runtime.js` 里属于 whistle 特有的只有三样——`boot()` 的 `state.booted` 单例、`alreadyServing()` + 10s 重试接管、以及 `index.js` 的 302。其余（SSE hub、`buildInjectHtml`、`handleRequest`、`readBody`、`PROBE_BUNDLE` 路径）全部进 `src/httpService.ts`。探针 bundle 的取路径方式要参数化：插件里是 `dist/probe.js`（同包），standalone 里同样是同包，所以保持相对 `__dirname` 即可，但要能注入覆盖以便测试。
- **README 里 `wv`/`whistle-vconsole` 命令残留要扫净**：全仓现只有 `README.md:59` 一处命令示例是 `command: "node"`，测试文件都是 `process.execPath` 直起 `dist/cli.cjs`，不受 bin 改名影响。
- **发布前置**：`bin` 字段改成 `"v2": "./dist/cli.cjs"` 后，`npm i -g` 的可用性只能靠真实安装验证（本机 `npm i -g ./whistle.vconsole-<ver>.tgz` → `v2 --help` → `v2 start`），不能只靠 dry-run。
- **stdout 纪律**：`start -f` 与裸 stdio 都必须守住「stdout 只属于 MCP/无输出，诊断全走 stderr」；`status`/`logs` 这类面向人的命令才允许往 stdout 打印。
