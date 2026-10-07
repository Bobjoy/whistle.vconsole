# @bobjoy/whistle.vconsole

whistle vConsole 插件 + MCP server + 设备面板，一个包全含。给移动端 H5 调试用：页面挂上探针后，日志 / 网络 / WebSocket 帧 / DOM / 存储 / Vue 状态就能被 AI agent（MCP 客户端）和本地面板同时读。完整说明见仓库根 [README](https://github.com/Bobjoy/whistle.vconsole#readme)。

## 两种装法（选一条，别同时装）

**whistle 插件（推荐，页面零改动）**——自带规则自动把探针注进被代理的 HTML：

```bash
w2 install whistle.vconsole-<版本>.tgz   # 仓库根 `pnpm --filter @bobjoy/whistle.vconsole build` 出的自包含 tgz
w2 start                               # hub :9528（WS）+ 面板与 MCP :9527
```

**standalone（不装 whistle）**——给你 `v2` 命令，但不做注入，页面得自己引探针：

```bash
npm i -g @bobjoy/whistle.vconsole
v2 start                               # 后台守护，端口同上
```

子命令 `start`（默认后台，`-f` 前台）/ `stop` / `status` / `logs [-f]`；pid 与日志在 `~/.whistle-vconsole/`。`status` 会报出 whistle 插件那份和全局那份的版本漂移。裸跑 `v2`（不带子命令）是 stdio MCP，一个客户端会话一个进程。

## MCP 客户端接入

```json
{
  "mcpServers": {
    "vconsole": { "type": "http", "url": "http://127.0.0.1:9527/mcp" }
  }
}
```

设备面板 `http://127.0.0.1:9527/` 右上角「MCP配置」里就是这份 JSON，按当前访问的 host 实时生成。16 个工具：`list_sessions` / `select_session` / `get_logs` / `wait_for` / `get_network` / `ws_frames` / `replay_request` / `eval_js` / `get_dom` / `get_vue_tree` / `get_vue_state` / `set_vue_state` / `get_storage` / `set_storage` / `get_page_info` / `screenshot`。

## 页面接入探针

- **whistle 注入**：装好插件即可，规则随插件生效（可在 whistle 的 Plugins 面板整体关掉，或把 `*` 改成具体域名）
- **npm 包**：`pnpm add -D @bobjoy/vconsole`，然后 `new VConsole({ serverUrl: 'ws://<局域网IP>:9528?t=<token>' })`
- **Vite 插件**：`@bobjoy/vconsole-vite`，dev 模式注入，见其 README
- **公网 CDN**：`https://unpkg.com/@bobjoy/vconsole@<版本>/dist/vconsole.min.js`（回程仍要连到你的 hub，https 页面只能走 `wss://`，得自己前置 TLS 隧道）

## 边界

整套只服务**同一局域网**：回环免鉴权，非回环必须带 `?t=<token>`（hub 启动时生成、打到 stderr、写进 `~/.whistle-vconsole/hub.json`）。绝不要把 9527/9528 暴露到公网或不可信网络。

探针 fork 自 [Tencent/vConsole](https://github.com/Tencent/vConsole)（MIT），源码在 [`Bobjoy/vConsole`](https://github.com/Bobjoy/vConsole) 的 `mcp` 分支。MIT。
