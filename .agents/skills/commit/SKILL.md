---
name: commit
description: dsh-vibe-trading 的提交规范：conventional commit 类型与版本影响、Release-As / Release-Gate / [skip release] footer、commit-msg 钩子的安装与报错处理。提交信息会直接决定自动发版的版本号，任何 git commit 前先读。
whenToUse: 当需要 git commit、拆分或整理提交、改写提交说明、判断该用哪个 type、或 commit-msg 钩子拒绝提交时。
---

# commit

## 为什么提交信息是发布输入

`release.yml` 在 CI 绿后按 `vX.Y.Z..HEAD` 的提交推导下一个版本，并写回 `package.json`、打 tag、
派发 npm 发布。`package.json` 的 `version` 不要手改（强制版本用 footer 或 workflow 输入）。

## 格式

```
<type>(<scope>)!: <description>
```

- `type` 只能是：`feat` `fix` `perf` `revert` `refactor` `docs` `test` `chore` `ci` `build` `style`
- 冒号后必须有一个空格；`scope` 可选（模块名，如 `worker` / `gate` / `release` / `ci`）
- description 用英文、动词开头、小写，尽量 ≤ 72 字符（>100 会被钩子拒绝）
- 破坏性变更用 `!`（`feat(api)!: ...`）或在正文写 `BREAKING CHANGE: ...`
- 一个提交只做一件事；不要把不相关改动混在一个提交里

## 类型与版本影响

| type | 版本 |
|---|---|
| `feat` | minor |
| `fix` `perf` `revert` | patch |
| `feat!` / `BREAKING CHANGE:` | 1.0 之前 bump minor；1.0 之后 bump major |
| `docs` `chore` `ci` `test` `style` `build` `refactor` | 不发版 |
| 不规范/未知前缀 | 按 patch 处理并告警（不要依赖这条兜底） |

一次推送里有多个提交时取最高级别；`docs` 等不发版提交不会出现在 Release notes 里。

## Footer

```
Release-As: 0.6.0
Release-Gate: verified (verify:all; parity; smoke: options_pricing; ui: plugin page)
[skip release]
```

- `Release-As: x.y.z`：强制下一个版本，必须大于当前版本（发 1.0 的唯一入口）。
- `Release-Gate: verified (...)`：改动了发布风险面时必须写，见 skill `release-gate`。
- `[skip release]`：该提交不计入发版（仍要通过格式检查）。

## 钩子

首次 clone（或换机器）后安装一次：

```bash
pnpm hooks:install   # git config core.hooksPath=.githooks
```

`commit-msg` 钩子会检查格式，并在改动风险面却缺少 `Release-Gate` footer 时拒绝提交。被拒绝时按提示改，
**不要用 `git commit --no-verify` 直接绕过**。确实需要临时绕过（例如先提交、稍后补验证记录）：

```bash
SKIP_COMMIT_HOOK=1 git commit ...
```

之后必须补一条带 footer 的记录提交，否则 `release.yml` 会拒绝打 tag。

CI 会对 PR 的提交再跑一遍 `node scripts/dev/check-commit.mjs range <base>..<head> --strict`。
Dependabot 的提交由 `.github/dependabot.yml` 的 `chore(deps)` 前缀保证不触发发版。

## 写错了怎么办

不要改写已推送的历史。补一条符合规范的提交（缺 gate 时例如
`chore: record release gate for v0.5.0` + `Release-Gate: verified (...)`），发布逻辑会认。

## 示例

```
feat(release): derive versions from conventional commits

chore(deps): bump typescript from 7.0.2 to 7.0.3
fix(gate): keep declared derived values in the evidence ledger
feat(worker)!: drop the legacy bridge

BREAKING CHANGE: the bridge tool is gone; use the gateway tools instead.
Release-Gate: verified (verify:all; parity; smoke: activation)
```
