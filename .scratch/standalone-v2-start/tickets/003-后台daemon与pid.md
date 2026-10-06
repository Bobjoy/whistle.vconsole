# `v2 start`：后台 daemon + pid/日志 + 就绪判定 + 幂等 + 撞口退出

**Blocked by**: 002

## 目标
`v2 start`（不带 `-f`）把服务丢到后台继续跑，父 shell 立刻拿回提示符；只在 :9527 真应答后才报成功，撞口就明确报错——「装完就能常驻」。

## 涉及层
- [ ] 数据层：`~/.whistle-vconsole/` 新增 `v2.pid`（单行 pid）与 `v2.log`（追加、不轮转）。把 `src/index.ts:69` 的 `HUB_FILE` 改成从同一个 `stateDir()` 派生，三个文件一个旋钮。
- [ ] 逻辑层：`start` 无 `-f` → `spawn(process.execPath, [CLI, 'start', '-f', ...原参数], { detached: true, stdio: ['ignore', logFd, logFd] })` + `unref()`，写 `v2.pid`。
- [ ] 逻辑层：就绪判定**不靠 sleep**——轮询 `GET 127.0.0.1:9527/api/sessions` 直到 200 且 body 含 `"sessions"`；超时（上限 3s）把 `v2.log` 尾部贴回 stderr 并非 0 退出，顺手杀掉刚 spawn 的进程。
- [ ] 逻辑层：`start` 幂等——先读 `v2.pid` 探活（`process.kill(pid,0)` + 端口应答），已在跑就打印当前状态退 0，绝不产生第二个 daemon。
- [ ] 逻辑层：撞 :9527（`EADDRINUSE`）且对端答得像自家面板 → 非 0 退出 + 提示「whistle 插件已在服务，直接用 `http://127.0.0.1:9527`」；不接管、不重试（复用 001 留在 `lib/runtime.js` 的 `alreadyServing` 判定思路，但不共享代码——插件侧要继续自愈）。
- [ ] UI层：无（CLI 输出）——`start` 成功时 stdout 打印面板 URL + 「`v2 logs` 看日志」；诊断走 stderr。
- [ ] 测试：`test/cli.e2e.mjs` 覆盖故事 2（父进程退出 0、`curl` 200）、3（故意让 9528 段端口被一个非 hub 进程占住 → `start` 失败退出且 stderr 含原因）、4（连跑两次 `v2 start` 只有一个 pid、`ps` 只有一个 daemon）、11（`w2 start` 后 `v2 start` 无新进程无 pid 文件）。

## 验收标准
- `v2 start` 后 `ps -p $(cat ~/.whistle-vconsole/v2.pid)` 存在，且该进程不是当前 shell 的子进程
- 连跑两次 `v2 start`：第二次输出「已在运行」+ 退 0，`v2.pid` 内容不变
- 端口占住场景：`v2 start` 退非 0 且 stderr 带日志尾部；`v2.pid` 不残留脏 pid
- 测试全部在临时 `HOME` 内跑完，真 `~/.whistle-vconsole/` 无残留
- `pnpm test:e2e` 全绿；`w2 start` 插件路径行为不变
