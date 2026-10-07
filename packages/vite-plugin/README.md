# @bobjoy/vconsole-vite

Vite 插件：dev 模式下自动把 [`@bobjoy/vconsole`](https://www.npmjs.com/package/@bobjoy/vconsole) 探针注入到每个 HTML 页面，页面源码零改动。探针连上 whistle-vconsole 的 WS hub 后，日志/网络/存储/DOM 就能被 AI agent（MCP）和本地面板读取。

## 安装

```bash
pnpm add -D @bobjoy/vconsole @bobjoy/vconsole-vite
```

hub 由 `@bobjoy/whistle.vconsole` 提供，默认 WS 端口 **9528**。两条起法选一条（安装细节见仓库根 README）：

- **whistle 插件**：`w2 start` 即在监听，顺带自动给被代理页面注入探针（`w2` 来自 whistle 本身：`npm i -g whistle`）
- **standalone**：不装 whistle，本插件负责把探针引进页面

```bash
npm i -g @bobjoy/whistle.vconsole && v2 start
```

## 用法

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import vconsoleMcp from '@bobjoy/vconsole-vite';

export default defineConfig({
  plugins: [
    vconsoleMcp({
      serverUrl: 'ws://192.168.x.x:9528?t=<token>', // 跑 hub 的开发机局域网 IP + 接入 token
    }),
  ],
});
```

token 从哪来：hub 启动时把带 token 的整串探针端点打到 stderr，也写进 `~/.whistle-vconsole/hub.json`。接入规则只有一条——**回环免鉴权，非回环必须带 `?t=`**，所以手机从局域网连过来就必须带上它，否则握手被拒。

`serverUrl` 是必填项；其余可选：

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `serverUrl` | `string` | — | hub 的 WebSocket 地址（非回环接入要带 `?t=<token>`） |
| `deviceName` | `string` | 自动指纹 | 在 `list_sessions` 里显示的设备标签 |
| `hideUI` | `boolean` | `false` | 隐藏 vConsole 悬浮按钮（纯 agent 调试） |
| `include` | `RegExp` | 全部页面 | 只注入 HTML 命中的页面 |
| `exclude` | `RegExp` | — | 跳过注入，优先级高于 `include` |

只在 dev（`vite serve`）注入，`vite build` 产物不含探针。探针代码由插件从 `@bobjoy/vconsole/dist/vconsole.min.js` 读入，并以 `/@whistle-vconsole/probe.js` 中间件提供，因此手机与开发机同网段直接访问 dev server 即可调试。

## 不用 Vite？

改用 whistle 插件 `@bobjoy/whistle.vconsole`：它随 `w2 start` 自动生效一条 `htmlPrepend` 规则，给所有被代理的 HTML 页面注入探针，同样不用改构建配置。

## License

MIT（探针代码 fork 自 Tencent vConsole，MIT）。
