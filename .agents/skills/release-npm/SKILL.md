---
name: release-npm
description: 发布 @monsterlee/dsh-vibe-trading 到 npm 的固定流程：只改 package.json 版本、运行校验、单独推 tag，由 GitHub Actions OIDC 发布并自动生成 GitHub Release。用于用户说“发个版本 / 发布新版本 / 推到 npm / 发版前检查”时；默认半自动，push 需要显式 --yes，不在本地执行 npm publish。
whenToUse: 当用户要求发布新版本、升版本号、打 release tag、检查 npm 发布状态，或问“怎么发版/为什么 tag 没触发发布”时。
---

# release-npm

## 核心规则

- **插件版本只有一个来源**：`package.json` 的 `version`。不要改 README/AGENTS/docs 里的版本号，安装示例使用 `@latest` / `@<version>`。
- **没有 CHANGELOG**：发布说明由 GitHub Release 自动生成（`gh release create --generate-notes`）。
- **tag 必须单独推**：先推 `main`，再推 `vX.Y.Z`。不要把 tag 和 `main` 放在同一次 `git push`。
- **不要在本地 `npm publish`**：CI 的 `.github/workflows/publish.yml` 用 npm Trusted Publishing（OIDC）发布；不需要 `NPM_TOKEN`。
- **不要复用版本号**：npm 上已存在的版本不能再发；失败时升一个新 patch。
- **不要从 fork 发布**：workflow 的 job 只允许 `lee88688/dsh-vibe-trading`。

## 半自动脚本

`scripts/dev/release.mjs` 只做版本/检查/tag/push，不发布 npm：

```bash
pnpm release:status                 # 版本、干净状态、tag、npm latest、下一个 patch
pnpm release:bump patch             # 只改 package.json（patch|minor|major|x.y.z）
pnpm release:verify                 # pnpm verify:ci
pnpm release:tag                    # 要求 main + clean，创建 annotated vX.Y.Z
node scripts/dev/release.mjs push --yes   # 先推 main，再单独推 tag
```

`bump` 和 `tag` 要求工作区干净；有代码改动时先正常提交，再做 release 提交。

## 标准流程

1. `git status` / `git pull origin main`；确认工作区干净、在 `main`。
2. 有功能/修复：先单独提交。
3. `pnpm release:bump patch`（或 `minor` / `major`）。
4. `pnpm release:verify`。如果改了 `worker/`、`prompt/`、数据源或工具面，再跑 `pnpm verify:all`（需要 `uv sync` + 外网）。
5. `git add package.json && git commit -m "release: vX.Y.Z"`。
6. `pnpm release:tag`。
7. `node scripts/dev/release.mjs push --yes`；脚本会分别执行：
   ```bash
   git push origin main
   git push origin vX.Y.Z
   ```
8. 在 Actions 看 **Publish npm**；成功后验证：
   ```bash
   npm view @monsterlee/dsh-vibe-trading version dist-tags \
     --registry https://registry.npmjs.org/ --prefer-online
   gh release view vX.Y.Z --repo lee88688/dsh-vibe-trading
   ```

## 失败处理

| 现象 | 处理 |
|---|---|
| tag 没触发 workflow | 确认 tag 是**单独**推的；必要时删除并重推 tag（版本未发布时） |
| tag/版本不一致 | 改 `package.json` 或重打 tag，不要跳过校验 |
| OIDC/认证失败 | 检查 npm Trusted Publisher：owner `lee88688`、repo `dsh-vibe-trading`、workflow `publish.yml`；workflow 有 `id-token: write` |
| 版本已存在 | `npm view` 确认；升一个新的 patch，不要重发同一版本 |
| npm 发布成功但 Release 失败 | 手动补：`gh release create vX.Y.Z --generate-notes --title "dsh-vibe-trading vX.Y.Z"` |
| npm 刚发布查不到 | 等 1–2 分钟，再用 `--prefer-online` 查询 |

## 不做的事

- 不维护 CHANGELOG；
- 不改 README/AGENTS/docs 的版本号；
- 不创建 `NPM_TOKEN`（历史 bootstrap 路径已完成，不再需要）；
- 不执行 `npm publish` / `npm login`；
- 不 `git push --tags` 一把推所有 tag。
