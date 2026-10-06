# 公开远端 + 各包 `repository` 字段补齐

**Blocked by**: 011　**外部依赖**：本仓库的 GitHub 仓库 URL。2026-10-06 用户先给的是 `Bobjoy/vconsole-mcp`（public、空），随后改口为 **`Bobjoy/whistle.vconsole`**——该仓库用户已自建（**private**、空），所以 GitHub 端 rename 会撞名，本仓库只把引用整体换到新名字。不要自己编 URL。

## 目标
本仓库有一个远端，三个发布物的 `package.json` 都能回答「源码在哪」；`git push` 之后 `git status` 干净。

## 已完成（2026-10-06，用户指令「改成 Bobjoy/whistle.vconsole，mcp 分支删掉重新用 Bobjoy 提交」）

- 三个 `repository.url` + spec 拓扑图 + 协议双副本文件头的路径全部换成 `whistle.vconsole` / 相对路径。
- fork `mcp` 分支整体重做身份：`git filter-branch --env-filter` 把 5 个提交（`4829ec3/58e570e/a44df10/570b55c/3885c13`，作者和提交者都是公司邮箱）改写成个人身份，**tree sha 前后一致**（`940a589…`，证明只动身份没动内容），随后 `push --delete mcp` + 重推。新链 `5554246 → 4739c38 → a4be233 → 402af4f → 9b45574 → 82c6f4d`（最后一个只改协议文件头，见下）。
  - 残留：被删掉的旧 sha 在服务端 GC 前仍可按 SHA 直取，GitHub 不承诺即刻抹除；本地 scratch clone `$HOME/study/project/vConsole` 还留着旧身份那份。
- 协议双副本文件头原本写死两个仓库名，仓库改名就过期了 → 改成各自仓库内的相对路径，两份保持字节一致。

## 涉及层
- [ ] git：加 remote 并 push（**需要用户明确授权**：这是第一次把整份历史推上去，且推送不可简单撤回）。当前基线只有 1 个 commit（`4b02050`，作者 `dev@local`，不含真实身份）+ 本轮迁移的提交。父仓库 `git config user.email` 仍是公司邮箱，提交要显式带 Bobjoy 身份。
- [ ] 依赖/元数据：`repository` 字段（实测现在**所有** `packages/*/package.json` 都没有这个字段——上一轮把假地址删掉了）：
  - `packages/whistle-plugin`、`packages/vite-plugin` → 用户给的本仓库 URL（`{"type":"git","url":"git+https://github.com/<owner>/<repo>.git"}`）
  - `packages/protocol` → 同一个 URL（它不发布，但源码可见性要说清）
  - fork 的 `packages/vconsole`（在 fork 里改）→ `https://github.com/Bobjoy/vConsole`，这条其实属于 ticket 002，本票只复查
- [ ] 文档：`README.md` 里任何「本仓库」链接、`docs/adr/*` 的相对引用不需要改（都用相对路径）；`README.md:115` 那句「`@bobjoy/vconsole` 还没发到 npm，这条 URL 现在会 404」在发包后要复查（不属本票）。

## 验收标准
- `git remote -v` 有 `origin`（指向 `Bobjoy/whistle.vconsole`）；push 后 `git status` 干净、无未推送提交
- GitHub 上仓库可见性 = **public**（2026-10-06 用户拍板「公开」，已 `gh repo edit --visibility public`），且默认分支内容不含 `.zcode/config.json`（011 已 ignore）、不含家目录绝对路径（工单里的写法统一换成 `$HOME`）
- 各包 `package.json` 的 `repository.url` 是一条真实可打开的 URL
- fork 侧 `git log mcp` 已推送到 `Bobjoy/vConsole`（submodule URL 才对别人有效）——**这条已满足**
- 收尾决定：空壳 `Bobjoy/vconsole-mcp` 删除——**卡在权限**：`gh api --method DELETE /repos/Bobjoy/vconsole-mcp` 返回 403（token 无 `delete_repo` scope）。要用户自己 `gh auth refresh -h github.com -s delete_repo` 后重试，或网页 Settings → Danger Zone 删。

## 备注
本票是唯一「写完就要推到公网」的一片，执行前必须单独确认。发布 npm（`pnpm publish --no-git-checks` + OTP）是**另一件事**，不在本票范围，见 spec §7。
