---
name: release-npm
description: dsh-vibe-trading 的自动发版流水线与 npm 发布运维：CI 绿后 release.yml 按 conventional commits 推导版本、写回 package.json、打 tag，并派发 publish.yml 用 OIDC 发布 npm、创建 GitHub Release。用于强制/跳过版本、排查“为什么没发/发布失败”、核对 npm 与 Release、配置 Trusted Publishing。
whenToUse: 当用户要求发版或指定版本、问为什么没有自动发版、发布失败需要重试、要核对 npm 上的版本，或要配置/排查 npm Trusted Publishing 时。
---

# release-npm

## 主路径（全自动）

```
push main
  └─ CI（ubuntu + windows）
       └─ Release workflow（workflow_run，需仓库变量 AUTO_RELEASE=true）
            ├─ 按 vX.Y.Z..HEAD 的提交算版本（feat→minor，fix→patch，破坏性→0.x minor）
            ├─ 风险面（prompt/worker/toolsets/client/engines.dsh）需 Release-Gate footer
            ├─ 提交 package.json、打 annotated tag、推 main + tag
            └─ gh workflow run publish.yml --ref vX.Y.Z
                 └─ pnpm verify:ci → npm publish（OIDC）→ GitHub Release（notes 由提交生成）
```

- 版本只有一个来源：`package.json`，由流水线写回；**不要手改版本号**。
- 没有 CHANGELOG；Release notes 由 `scripts/dev/release-plan.mjs` 从 conventional commits 生成。
- 发布 job 跑在 **tag ref** 上，provenance 指向 tag 提交；不要在 main 的 run 里直接 `npm publish`。
- `publish.yml` 的文件名不能改：npm Trusted Publisher 绑定的是“仓库 + workflow 文件名”。

## 规则

- 不在本地 `npm publish`、不创建 `NPM_TOKEN`；OIDC 自动带 provenance。
- 同一个版本不能发两次；失败就升新 patch，或对同一 tag 重跑 publish。
- 不从 fork 发布；workflow 只允许 `lee88688/dsh-vibe-trading`。
- `[skip release]` 的提交不计入发版；Dependabot 用 `chore(deps)` 前缀，本身不触发发版。

## 手动入口（异常时）

| 目的 | 做法 |
|---|---|
| 预览下一次版本（不发布） | Actions → **Release** → Run workflow → `dry_run=true`；本地可 `pnpm release:plan` |
| 强制版本 | Release → Run workflow → `version=0.5.0`（必须大于当前 tag） |
| 已人工验证但要绕过 gate | Release → Run workflow → `force=true` |
| 暂停自动发版 | 仓库变量 `AUTO_RELEASE=false`（或删除） |
| npm 发布失败 / 想重试 | Actions → **Publish npm** → Run workflow，选 `vX.Y.Z` tag（`gh workflow run publish.yml --ref vX.Y.Z`） |
| 只想先打 tag | 本地 `pnpm release:tag` + 单独推 tag（会把 `main` 上现有版本发出去） |
| 完全离线的手动兜底 | `pnpm release:bump patch` → 提交 → `pnpm release:tag` → `node scripts/dev/release.mjs push --yes` |

`scripts/dev/release.mjs` 只改 `package.json` / 建 tag / 推 main+tag，不会执行 `npm publish`。

## 校验发布结果

```bash
npm view @monsterlee/dsh-vibe-trading version dist-tags --registry https://registry.npmjs.org/ --prefer-online
gh release view vX.Y.Z --repo lee88688/dsh-vibe-trading
gh run list --workflow=publish.yml --limit 3
```

npm 刚发布可能延迟 1–2 分钟，用 `--prefer-online` 再查。

## 失败处理

| 现象 | 处理 |
|---|---|
| Release workflow 没跑 | 检查仓库变量 `AUTO_RELEASE`、CI 是否成功、job 是否因“不是 main 顶端”被跳过 |
| Release 被 gate 拦住 | 按 skill `release-gate` 验证后补 footer 提交；或人工验证后 `force=true` |
| tag 已推、publish 没触发 | `gh workflow run publish.yml --ref vX.Y.Z`；再不行检查 `actions: write` 权限 |
| publish 失败在认证 | 检查 npm Trusted Publisher：owner `lee88688`、repo `dsh-vibe-trading`、workflow `publish.yml`；workflow 有 `id-token: write` |
| 版本已在 npm | `npm view` 确认；升新 patch，不要重发同一版本 |
| npm 成功但 Release 失败 | `gh release create vX.Y.Z --generate-notes` 补建 |
| 发错版本 | 发新 patch 覆盖 `latest`；不要指望 unpublish |

## 不做的事

- 不维护 CHANGELOG、不改 README/AGENTS/docs 里的版本号；
- 不 `git push --tags` 一把推所有 tag；
- 不在本地执行 `npm publish` / `npm login`。
