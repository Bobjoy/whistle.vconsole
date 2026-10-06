# ADR-0007: 包拓扑收敛——服务与 whistle 接入保持同一个发布物，协议回到两侧内联副本

日期：2026-10-06　状态：Accepted　关联：ADR-005（已否决过"拆 `v2-cli` + 插件薄壳"）、ADR-006、ADR-008

## 背景

重新规划时提过四个包：`vconsole`（探针）、`cli`（http+sse+ws 服务）、`mcp`（MCP 能力，依赖 cli）、`whistle-plugin`（设备列表与调试 UI，依赖 cli）。逐条查下来有两处站不住：

1. **whistle 对包名有硬门**：`w2 install` 只接受匹配 `^((?:@scope/)?whistle\.[a-z\d_-]+)` 的包名，或文件名匹配 `whistle.<x>-<ver>.tgz` 的 tgz（whistle `lib/util/common.js:56-57,234`）；插件短名取最后一个 `.` 之后的部分（`lib/plugins/util.js:73`，所以现在 `@bobjoy/whistle.vconsole` → 菜单 `/plugin.vconsole/`、rules value `vconsole://`）。**服务包一旦叫 `vconsole-cli`，whistle 根本不认它是插件。**
2. **MCP 拆成独立进程会掉两条现成能力**：`/mcp` 现在就挂在服务的 HTTP 面上（`src/httpService.ts:262`），agent 只需配一条 `{"type":"http","url":"http://127.0.0.1:9527/mcp"}`；而裸跑 `v2` 时那个 stdio 进程自己就是 hub，不需要后台服务先起来。若按"mcp 依赖 cli"严格走——MCP 进程通过 `/api/tool` 反向访问服务——这两条都要重写，全局 bin 还得多一个。

协议是另一道题。它现在靠"探针侧 webpack `resolve.alias` + 插件侧 tsconfig `paths` 直指同一份源码"实现单一来源（v2.1 特意收敛掉的正是人工双副本），探针搬去独立仓库后"直指源码"不再成立。三条出路各有代价：

- **发公开 npm 包按版本依赖**：契约最干净，但要多一条构建链（ESM+CJS+dts）、发布顺序变四步，且实测 pnpm 9.9.0 不把 caret 范围（`^0.4.0`）链到同名 workspace 包（会直接去 registry 取并 404），本地联调必须再开一个 `link-workspace-packages=true` 旋钮。
- **Node 侧跨仓库 alias 直指 submodule 里的源码**：单一来源保住了，但本仓库构建从此强依赖 `submodule update --init`，而 fork 单独 clone 时那份源码又引用不到父仓库路径——两边都不能独立构建。
- **两侧各留一份内联副本**：会漂。

## 决策

**3 个发布物 + 1 个 submodule；服务与 whistle 接入不拆包；协议不发包，两侧各持一份内联副本。**

| 包 | 目录 | 装的东西 |
|----|------|----------|
| `@bobjoy/vconsole` | `packages/vconsole`（submodule → `Bobjoy/vConsole` 的 `mcp` 分支） | 探针 + `src/mcp/*` 桥 + **协议副本 `src/mcp/protocol.ts`** + 探针侧单测 |
| （不发布）`@bobjoy/vconsole-protocol` | `packages/protocol` | 保持 `private: true`：Node 侧那份协议源，构建期内联，发布物里不存在 |
| `@bobjoy/whistle.vconsole` | `packages/whistle-plugin`（目录名不改） | hub(9528) + HTTP 面(9527：面板、`/api/*`、`/probe.js`、`/inject.html`、`/mcp`) + daemon(`v2`) + 面板 UI + MCP 层 + whistle 接入（`rules.txt`、插件入口、菜单 redirect） |
| `@bobjoy/vconsole-vite` | `packages/vite-plugin` | 保留发包，继续依赖 `@bobjoy/vconsole` |

- **面板跟服务同包**：两条启动形态共用一份 UI，不允许插件和 standalone 各存一份。
- **MCP 不另起进程**：`/mcp` 与 stdio 入口都在同一个进程内，`packages/mcp` 不成包。
- **插件继续自包含 bundle**：`bundleDependencies` 带上 `ws` / MCP SDK / `zod`，探针产物构建期从 submodule 拷成 `dist/probe.js`——`w2 install <tgz> --offline` 这条能力不丢。
- **本仓库建 GitHub 公开远端**，`repository` 字段填它，submodule URL 用公开 https。

## 后果

- **协议改动必须同一轮动两处**（本仓库 `packages/protocol/src/protocol.ts` 与 fork 的 `src/mcp/protocol.ts`）——这是这次决定主动接下的税，它翻案了 v2.1 的"协议单一来源"收敛。接下的理由：两条替代方案各自换来的东西（多一条发包链 + 一个 pnpm 旋钮，或两边都无法独立构建）都比"改协议时多改一个文件"更贵。
- 可见漂移的出口是 `PROTOCOL_VERSION` 握手（ADR-0008），不是构建期报错。
- 两侧构建配置几乎不动：探针侧继续用自己的副本，Node 侧继续 tsconfig `paths` 直指 `packages/protocol`。不新增 `.npmrc` 开关，也不新增构建前拷贝脚本。
- 发布链只有三个包且互不阻塞：`@bobjoy/vconsole`（在 fork 发）→ `@bobjoy/whistle.vconsole` → `@bobjoy/vconsole-vite`。
- 本机默认 registry 是 `registry.npmmirror.com`（镜像有同步延迟），装自己刚发布的版本必须显式 `--registry=https://registry.npmjs.org/`。
- 仓库公开前要把内容扫干净：`192.168.1.10` 字面量（`packages/protocol/src/protocol.ts:274`、`packages/vite-plugin/README.md:27` 等，fork 那份副本同理）、未入库却被 README 引用的 `.zcode/config.json`（内含绝对路径与用户名）。

## 被否决的方案

- **`@bobjoy/vconsole-cli`（服务）+ 插件真依赖它**：包名先过不了 whistle 的门；即便改用 `@bobjoy/whistle.*` 命名，插件也不再自包含，离线 tgz 要连带把 cli 的依赖链打全，两个版本还得人肉配对。
- **一份源码发两个名字（插件那个把 cli bundle 进去）**：两边名字都干净，但一次 release 发两个包、版本必须绑死，换来的只是命名洁癖。
- **MCP 作为 cli 的进程客户端（严格 mcp→cli）**：依赖方向顺眼了，代价是 `/mcp` 从服务消失、裸跑 stdio 不再自带 hub、全局 bin 变两个。
- **面板拆独立包**：面板只服务这一套 `/api/*`，没有第二个客户，多一个发布物纯属负担。
- **`@bobjoy/vconsole-protocol` 发公开包** / **Node 侧跨仓库 alias 直指 fork 源码**：见「背景」，本轮先选发包、量完代价后又翻回双副本，两条都留个记录以免再来一轮。
