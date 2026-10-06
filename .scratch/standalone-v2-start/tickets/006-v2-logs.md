# `v2 logs`：尾读 200 行 + `-f` 跟随

**Blocked by**: 003

## 目标
`v2 logs` 让人不看终端历史就能拿到 daemon 的诊断（含 token 与探针端点），`-f` 能跟着流。

## 涉及层
- [ ] 数据层：读 `~/.whistle-vconsole/v2.log`（与 003 同文件，只读不写、不轮转）。
- [ ] 逻辑层：默认尾 200 行；`v2 logs -f` 从尾部开始跟随（`fs.watch` 或 500ms 轮询 `size` 增量读，选实现简单的那个），Ctrl-C 只退出 tail，**不停服务**。
- [ ] 逻辑层：日志文件不存在 → 提示「还没有 daemon 日志，先 `v2 start`」退 0；`-f` 时文件出现后开始跟（不做 tail-follow 的重试预算，靠一个 `fs.watch`）。
- [ ] 测试：`test/cli.e2e.mjs` 覆盖故事 10——`start` 后连一个假设备（复用 `test/http.e2e.mjs` 的 `makeProbe` 思路）并触发一条探针日志，`v2 logs` 里出现；再起一个 `v2 logs -f` 子进程，追加一行后它输出该行，SIGINT 它之后 daemon 仍然 200。

## 验收标准
- `v2 logs` 输出 ≤200 行且顺序为文件原序
- `v2 logs -f` 收到新行；SIGINT 后 `curl :9527/api/sessions` 仍 200、`v2.pid` 不变
- `v2 logs` 的 stdout 里能看到 token（这是它被指着当出口的地方），`status` 里没有
