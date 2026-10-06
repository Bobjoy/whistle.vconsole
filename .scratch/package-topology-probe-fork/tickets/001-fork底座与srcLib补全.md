# fork 底座：clone + `mcp` 分支

**Blocked by**: 无

## 目标
在 `Bobjoy/vConsole` 的本地工作副本里立起 `mcp` 分支，从此 fork 是一个「克隆出来能构建」的容器，后面的搬迁才有落点。

## 实测修正（2026-10-06，做 001 时）
原标题里的「修好 `.gitignore` 把 `src/lib` 收进 git」**在 fork 侧是空操作**：fork `dev` 的 `.gitignore` 只有 `dist`/`typings`，从来没有裸 `lib` 那一行（那是我们抄目录时自己加的），而 7 个 `src/lib/*` 早就被 git 跟踪、blob 与本仓库逐字节相同。于是本票只剩「开分支」一件事；那条洞的修法挪到 002 落地——**搬迁时不把 `lib` 这一行带过去**。

## 涉及层
- [x] git：`git clone git@github.com:Bobjoy/vConsole.git`（本轮已实测：远端只有 `dev`，HEAD = `de7026d`）。放在本仓库**之外**的同级目录 `$HOME/study/project/vConsole`，因为 `packages/vconsole` 这个位置还被 `packages/probe` 占着。
  - https 克隆在这台机上两次 `Empty reply from server`，改 ssh 成功；`gh` 也是走 ssh。
- [x] git：校验 `dev` 是 upstream 镜像——`git merge-base --is-ancestor upstream/dev dev` 成立，`dev` 顶端 `de7026d` 与 `Tencent/vConsole` 的 `dev` 同一个 commit，上面没有我们的提交。
- [x] git：从 `dev` 开 `mcp` 分支。
- [x] 文件：`.gitignore` 与 `src/lib` 都不需要动（见上面的实测修正）。

## 验收标准
- `git ls-files src/lib | wc -l` = **7**（fork 本来就满足）
- `git check-ignore -v src/lib/model.ts` 无输出（fork 本来就满足）
- `git merge-base --is-ancestor upstream/dev dev` 返回 0
- `git rev-parse --abbrev-ref HEAD` = `mcp`，且 `git log mcp --oneline` 顶端仍是 `de7026d`（本票不产生提交）
- 在 `mcp` 上 `npm ci && npm run build` 出 `dist/vconsole.min.js`（纯 upstream，不含我们的改动）

## 备注
裸 `lib` 匹配**任意层级**的 `lib` 目录，会连 `src/lib/` 一起吞掉——这个洞在本仓库是事实，只是它不会随 fork 的 `.gitignore` 进来，只要 002 别把它抄过去。
