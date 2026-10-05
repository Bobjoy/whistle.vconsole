# ADR-002: 对外网络面收敛为「:9527 单 HTTP 口 + :9528 hub 口」，公网 relay 搁置

日期：2026-10-05　状态：Accepted

## 背景

插件把 MCP server、设备面板、探针资源全搬进了 whistle 进程（随 `w2 start` 起停）。于是必须回答两个问题：这些 HTTP 面要不要拆成多个端口；手机和开发机不在同一局域网时怎么办（公网中转）。第六轮把 MCP/面板端口统一到 9527 之后，`HANDOFF.md` 第八节一直挂着「单端口耦合要不要拆」和「公网 relay 未开工」两条待办。

## 决策

**保持现状，不再拆端口，也不做 relay。** 对外只有两个端口，且都只面向同一局域网：

| 端口 | 承载 | 谁访问 |
|---|---|---|
| `:9527` 单个 Node http server（`lib/runtime.js`，`MCP_HTTP_PORT`） | `/mcp`（stateless Streamable HTTP）、`/api/tool`、`/api/sessions`、`/api/events`（面板 SSE）、`/`（面板）、`/probe.js`、`/inject.html` | agent（`/mcp`）、开发者浏览器（面板）、whistle 自身（抓 `inject.html`） |
| `:9528` ws hub（`src/hub.ts` 自建 http server） | WS 升级 + 同一端口的 `GET /html2canvas.min.js`（`src/staticAssets.ts`，见 ADR-001 修订） | 手机/设备上的探针 |

拆口的代价是真实的：多一个端口就多一处 `EADDRINUSE` 与残留进程（`runtime.js` 里为了抢 9527 已经写了「另一 whistle 进程占口就 10s 后重试接管」的自愈逻辑），而面板和 MCP 本来就共用同一个 `backend.handleTool`，拆口会把一次进程内调用变成跨进程转发。资源口跟着 hub 端口走也是同一个理由：探针只需要连得上 `serverUrl`，截图依赖就能拿到，不必再假设手机能访问开发机的第二个端口。

## 由此确定的边界

1. **无鉴权，`0.0.0.0` 监听**——同一局域网内任何主机都能连 `/mcp`、看面板、接 hub。这是刻意取舍（本机调试工具，加 token 会把「粘一段配置就能用」变成「先分发密钥」），因此**严禁把这两个端口暴露到公网或不可信网络**。
2. **给人看的地址一律用实时 LAN IP，不用环回**：手机经 whistle 代理时 `127.0.0.1` 指向手机自己——whistle 的 Plugins 入口（`index.js` 的 `uiServer`）就是 `302 → http://127.0.0.1:9527/`，所以手机点插件链接打不开面板，必须直接访问 `http://<lan>:9527/`；`rules.txt` 里 `htmlPrepend://http://127.0.0.1:9527/inject.html` 反过来是**只给 whistle 本机抓**的，抓完内联，手机侧真正抓的是 `http://<lan>:9527/probe.js`。`inject.html` 里的探针地址、面板里的 MCP 配置都由 `getLanAddresses()` 实时算出，不落盘。
3. **跨网段 / 公网调试不在范围内**。真需要时把这两个端口透出去（whistle 的代理规则、系统/路由器端口映射、或自己已有的隧道工具），或给探针配一个可达的 `serverUrl`——项目本身不再内置第三层中转。

## 备选方案与否决理由

- **面板/静态资源改由 whistle 自身 serve，`/mcp` + `/api` 独立端口**：要接 whistle 的 `uiServer`/静态目录约定，端口发现与热重载逻辑得重写，收益只有「少占一个自己的端口」。否决。
- **公网 relay（hub 侧中转，协议已预留 proxy 通道：`MCP_PROXY_SESSION_ID` + `ApiMsg`）**：通道本身是给**本机多进程共享同一个 hub** 用的（stdio 回退 + 插件同时起，`multi-session.e2e.mjs` 验的就是这条）。搬到公网要额外解决三件事——中继服务器的部署与运维、接入鉴权与多租户隔离（当前刻意无鉴权，公网裸奔不可接受）、以及日志/网络帧里业务敏感数据的加密与留存责任。目标场景（PC 浏览器 / 手机浏览器 / 微信与 app webview，同局域网）已被三种接入方式覆盖，收益不确定而成本与风险明确。搁置，README 路线图保留 v2.x。
- **给 MCP/面板加 token**：与「随手粘配置就能用」冲突，且局域网内的威胁模型本就不靠它。已在第六轮移除，不再重加。

## 什么时候该重新审视

出现真实的跨网段/公网调试诉求且用户不愿自己搭隧道；或需要把 9527/9528 暴露给非可信网络（那时鉴权是前置条件，不是可选项）。
