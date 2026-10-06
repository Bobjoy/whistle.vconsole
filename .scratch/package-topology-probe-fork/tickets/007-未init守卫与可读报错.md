# 未 init 的守卫：`pnpm build` 立刻说人话，而不是 ENOENT

**Blocked by**: 005

## 目标
新克隆的人忘了 `--recursive` 时，`pnpm build` 在第一步就失败并告诉他跑 `git submodule update --init`——而不是抛 "Cannot find module"、"ENOENT dist/vconsole.min.js" 这类要读者自己反推拓扑的错。

## 涉及层
- [ ] 构建：新增一个只读检查（`scripts/require-probe-source.mjs`，约 6 行）：`packages/vconsole/package.json` 或 `packages/vconsole/src/vconsole.ts` 不存在 → `console.error` 打印**含 `git submodule update --init` 的一句话**并 `process.exit(1)`；存在则静默退出 0。
- [ ] 逻辑层：根 `package.json` 的 `build` 脚本前置它（`node scripts/require-probe-source.mjs && pnpm --filter @bobjoy/vconsole build && ...`）。为什么必须前置在根：`packages/vconsole` 空目录时 `pnpm install` 根本不把它当 workspace 成员，`pnpm --filter @bobjoy/vconsole build` 会变成 "No projects matched the filters" 并**以 0 退出**——后面 vite/plugin 段才开始报莫名其妙的错。
- [ ] 构建（可选同一处）：`packages/whistle-plugin/build.mjs:27` 那次拷贝前顺手 `fs.existsSync` 检查，缺失时的报错同样点名 `git submodule update --init`（这条是给「只跑插件 build」的人兜底，不新增旋钮）。
- [ ] 测试：手工验（见验收），**不加自动化测试**——守卫测的是 git 目录状态，为它引入一个测试文件不值当（spec §5 的「完成定义」本来就写的是手工验一次）。

## 验收标准
- `mv packages/vconsole /tmp/vconsole-away && pnpm build` → **第一步**就退出码 1，stderr 里能读到 `git submodule update --init`；`mv` 回来后 `pnpm build` 恢复绿
- 同一状态下 `node packages/whistle-plugin/build.mjs` 也给出带 `git submodule update --init` 的报错，而不是 ENOENT 堆栈
- `packages/vconsole` 在位时两个命令的输出**没有任何新增噪音**（守卫静默）
- 文案不提「重装依赖」「pnpm install」之类的误导建议：唯一正确的下一步就是 submodule init

## 备注
这是 spec US-10 全部的内容，不含任何功能改动。做完就把 `packages/vconsole` 放回原处——本票的验收是一次破坏性手工操作，不是状态迁移。
