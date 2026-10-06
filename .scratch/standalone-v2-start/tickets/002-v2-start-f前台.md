# `v2 start -f`：前台 standalone 打通 CLI 接缝

**Blocked by**: 001

## 目标
`node dist/cli.cjs start -f --port <hubPort>` 一条命令把 hub(:9528) + 整套 HTTP 面(:9527) 起在自己进程里，stderr 打印接入所需的一切——standalone 第一次可用。

## 涉及层
- [ ] 逻辑层：`src/cli.ts` 现在只有 `startWithStdio`（`:52-56`）。加子命令分派：`start`/`stop`/`status`/`logs`，这片只实现 `start -f`（无 `-f` 时先落到 `-f` 同路径，003 再接管后台）；裸跑（无子命令）仍是 stdio MCP，行为不变。
- [ ] 逻辑层：`start -f` = `createBackend({ onData/onSessionEvent 由 createHttpService 内部处理 })` + `createHttpService({ ... })`。参数 `--port/--host/--token` 与裸 stdio 走同一条解析（故事 5）。
- [ ] 逻辑层：stderr 输出四行——面板 URL、MCP url(`http://127.0.0.1:9527/mcp`)、每个网卡的探针端点（含 `?t=`，来自 `getLanAddresses`）、以及一行「standalone 没有自动注入，页面需自己引探针」。
- [ ] 逻辑层：stdout 纪律——`start -f` 与裸 stdio 都不许往 stdout 写任何东西（诊断全 stderr）。
- [ ] 测试：新建 `test/cli.e2e.mjs`，用 `spawn(process.execPath, ['dist/cli.cjs','start','-f','--port',P,'--host','127.0.0.1','--token',tk], { env: { ...process.env, HOME: tmpHome } })`。覆盖故事 1（Ctrl-C 等价：SIGINT 后两端拒绝应答）与故事 5（`hub.json` 的 `port` 等于传入值）。

## 验收标准
- `v2 start -f --port 9301 --host 127.0.0.1 --token aa..` → stderr 四行齐全，stdout 全程 0 字节
- SIGINT 后 `curl 127.0.0.1:9527/api/sessions` 与 `ws://127.0.0.1:9301` 均拒连
- `node packages/whistle-plugin/test/cli.e2e.mjs` 绿；`pnpm test:e2e` 把它加进串联
- 临时 `HOME` 下的 `~/.whistle-vconsole/hub.json` 里 `port` 是 9301

## 备注（两处实测约束，实现时别踩）
1. **HTTP 面固定 9527、没有 `--http-port`**（明确不做）。所以 `cli.e2e.mjs` 只能**串行**跑：一个 case 起停完再起下一个；开跑前先探 `:9527`，若本机已有 daemon 在服务就报明确错误并退出，而不是误判成断言失败。
2. `src/index.ts:69` 的 `HUB_FILE` 是**模块级 const**（`os.homedir()`）。测试靠 `spawn` 新进程传 `env.HOME` 才生效——同进程改 `HOME` 不会重算。
