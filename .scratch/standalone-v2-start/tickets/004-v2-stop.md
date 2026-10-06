# `v2 stop`：只杀自己记的 pid

**Blocked by**: 003

## 目标
`v2 stop` 干净停掉自家 daemon 并释放端口；碰到「端口有人但不是自家进程」时明确不动任何进程——这条边界是全案唯一可能误杀 whistle 的地方。

## 涉及层
- [ ] 数据层：读 `~/.whistle-vconsole/v2.pid`；成功停止后删该文件。
- [ ] 逻辑层：`stop` = 读 pid → `process.kill(pid, 'SIGTERM')` → 等 :9527 停止应答（上限 3s，轮询而非 sleep）→ 删 pid 文件 → stdout 报「已停止」。pid 文件缺失或进程已死 → 清掉文件并报「没有 v2 daemon 在跑」，退 0。
- [ ] 逻辑层：**绝不按端口反查 pid**（不用 `lsof`/`netstat`/`pid-port` 之类）。若 pid 不可用而 :9527 仍在应答 → 打印「这个端口不是 v2 daemon 在服务（可能是 whistle 插件）」，不动任何进程。
- [ ] 测试：`test/cli.e2e.mjs` 覆盖故事 6（停完 `curl :9527` 拒连 + pid 文件已删）与故事 7（只跑 `w2 start` 时执行 `v2 stop`：whistle 进程 pid 不变、面板仍可访问、输出含那句提示）。

## 验收标准
- `v2 start` → `v2 stop`：端口拒连、`v2.pid` 消失、退出码 0
- `stop` 后再 `start` 能正常起来（pid 文件不脏）
- 插件场景：`w2 start` 后 `v2 stop` → whistle pid 前后一致（测试里用 `pgrep -f whistle` 快照比对），面板 200
- 「端口有人但非自家 pid」时退出码 **1**（明示没停成，脚本能察觉）—这条是本文自拍的边界，spec 未定，实现时如有异议改这里

## 备注
`SIGTERM` 后 daemon 里的 `hub.stop()` / `server.close()` 要真退出；若 3s 内没释放就再发一次 SIGTERM 并报告，**不要**升级成 SIGKILL（会留下 :9528 半开状态，下次 `start` 撞口更难解释）。
