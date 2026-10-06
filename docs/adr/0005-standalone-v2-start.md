# ADR-005: standalone 守护服务与 whistle 插件共存，共用同一套 HTTP 面实现

日期：2026-10-06　状态：Accepted

## 背景

hub、面板、MCP-over-HTTP、`/probe.js`、`/inject.html` 全都写在 `lib/runtime.js` 里，只被 whistle 的 `uiServer` 钩子触发（ADR-002）。结果是：不用 whistle 就没法调试——而注入恰恰是 whistle 提供的能力之一，不是面板/MCP 的必要条件。CLI（`src/cli.ts`）虽然已经有 `bin`，但只会起 stdio MCP，没有 HTTP 面。

支撑这次拆分的两个事实：`runtime.js` 的 HTTP 面**不调任何 whistle hooks API**（自建 `http.createServer`，只被 `uiServer` 的触发点摸到），所以能原样搬到 `src/` 给两个入口共用；whistle 真正独占的是插件身份本身（Plugins 入口 302 到面板）和 `rules.txt` 的自动注入——这两样脱离 whistle 就不存在，不是搬运能解决的。

## 决策

**把 `lib/runtime.js` 的 HTTP 服务上移到 `src/`，两个入口调同一份实现；插件路径行为零变化。**

- **standalone**：`v2 start` 起 hub(9528) + HTTP 面(9527：面板 / `/mcp` / `/api/*` / `/probe.js` / `/inject.html`)。默认后台 detached，`-f` 前台；`stop` / `status` / `logs` 管理它，pid 与日志落在 `~/.whistle-vconsole/`（与 `hub.json` 同目录）。
- **bin 名收成 `v2`**：一个名字，不留别名。`whistle-vconsole` 太长；`wv` 与 git worktree 的常见别名撞车；`vconsole`/`wvconsole` 和跑在页面里的那个探针包同名，两个指代混在一起。裸跑 `v2` 仍是 stdio MCP，保证「一个 agent 会话一个进程」的旧用法不摔（旧配置里的 `whistle-vconsole` 要改，README 示例同步）。
- **端口只有一个 owner**：`v2 start` 绑不上 9527 且对端答得像自家面板时报错退出，提示「whistle 插件已在服务，直接用 `http://127.0.0.1:9527`」。不接管、不换端口。反方向（standalone 先起、whistle 后起）靠既有的 `hub.json` 发现机制：插件的 `createBackend` 撞 9528 就转 proxy 模式，并读到同一个 token，注入与面板照样能用 standalone 那个进程。

## 由此确定的边界

- standalone **没有自动注入**：页面必须自己引探针（`@bobjoy/vconsole` 或 CDN 外链，见 ADR-004 的公网限制）。`start` 不额外打印 HTML `<script>` 接入片段，接入方式只由 README 承担；token 从日志取。
- **`stop` 只认 pid 文件里那个进程**，不按端口反查 kill —— 端口上可能站着 whistle，杀 whistle 不是这个命令的权限。
- whistle 侧的 pfork 自愈逻辑（`alreadyServing()` + 10s 重试）留在 `lib/runtime.js`，不下沉到 `src/`——那是 whistle 多进程特有的，独立进程不需要。
- 不做 `restart`：`stop` 再 `start` 就是 restart，不值得一个子命令。
- **两条安装路径共存，仍是一个发布物**：`w2 install` 把包落到 `~/.WhistleAppData/custom_plugins/…`（有自动注入，不生成全局命令），`npm i -g` 落到全局 `node_modules` 并链出 `v2`（有命令，没有注入）。两者各装一份代码、互不取代，代价是版本可能漂移，所以 `v2 status` 除了报「谁在服务 9527」还要比对全局版本与插件目录版本，不一致就提示。

## 被否决的方案

- **standalone 取代插件**：丢掉「页面零改动」这个主要卖点，`rules.txt` 的注入能力只能靠 whistle。
- **standalone 只起 hub+MCP，不要面板**：改动最小，但脱离 whistle 就没有可视化面，设备列表只能靠 agent 工具问。
- **`start` 自动接管 / 加 `--http-port` 换端口**：接管要和 whistle 的 pfork 重启反复抢口；可配端口会牵动面板 URL、`/probe.js` 地址、注入规则、token 展示四处，多一个旋钮换不到对应用户价值。
- **给 standalone 自带极简 HTML 代理做注入**：等于在包里重新发明 whistle，且要处理 HTTPS/证书，与 ADR-002「不做 relay」冲突。
- **拆成 `v2-cli` + 插件薄壳两个发布物**：安装语义更清楚，但多一个包要发、要维护版本对齐，而 whistle 的离线 tgz 必须把这条依赖链打全；单包 + `status` 报版本已能压住漂移风险。
- **bin 名 `wv` / `vconsole` / 多个别名并存**：`wv` 撞 git worktree 习惯，`vconsole` 撞探针包名，多名指同一 CLI 违反「一个旋钮」。
- **只前台不起 daemon**：改动最省，但要用户自己 `nohup`/`&`，且没有 `status` 可问「现在到底是谁在服务 9527」。
