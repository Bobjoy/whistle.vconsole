# `v2 status`：三态 owner + 版本漂移

**Blocked by**: 003

## 目标
`v2 status` 一眼看清「现在是谁在服务 9527、我该怎么接」，并在插件与全局包版本不一致时提醒——这是「单包两条安装路」唯一的兜底手段。

## 涉及层
- [ ] 逻辑层：三态判定（顺序：先看 pid 是否活，再看端口是否应答）：
  - `daemon` — `v2.pid` 活的 **且** :9527 应答
  - `in-plugin` — :9527 应答但 pid 不对/缺失
  - `stopped` — 两者皆无
- [ ] 逻辑层：输出面板 URL、MCP url、探针端点（LAN ip + 端口，**不含 token**，指向 `v2 logs` 去看）；`in-plugin` 额外提示「这是 whistle 插件在服务，standalone 无需再起」。
- [ ] 逻辑层：版本漂移——比对全局包自身的 `VERSION`（`src/index.ts:29`，与 `package.json` 一致）和 `~/.WhistleAppData/custom_plugins/@bobjoy/whistle.vconsole/node_modules/@bobjoy/whistle.vconsole/package.json` 的 `version`；两边都存在且不等 → 打印一行提示（只提示不修）。
- [ ] 测试：`test/cli.e2e.mjs` 覆盖故事 8（三态分别跑一次，输出匹配；断言全文不含 token 十六进制串）与故事 9（手工把插件目录里 `package.json` 的 version 改成别的值 → 出现提示行；改回后消失）。

## 验收标准
- 三态可区分且退出码统一 0（`status` 是查询，不是断言）
- 输出用正则断言：`token` 的 hex 值 **不出现**
- 版本一致时无提示行；不一致时恰好一行
- 未装 whistle（`custom_plugins` 不存在）时不报错、不提版本
