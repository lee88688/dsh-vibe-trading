---
name: release-gate
description: 改动 prompt/、worker/、toolsets.json、client.js 或 package.json 的 engines.dsh 时，自动发版要求提交带 `Release-Gate: verified` footer。本 skill 规定必须先跑的校验、真机会话与前端验收、footer 写法，以及跑不了时怎么办。
whenToUse: 当提交会改动 prompt/、worker/、toolsets.json、client.js、engines.dsh，或 release workflow 因缺少 release gate 被拦住、需要判断一个变更能否标 verified 时。
---

# release-gate

自动发版对“风险面”变更要求一条人工验证凭据：没有它，`release.yml` 不会打 tag、不会发布。
这样既保留了全自动，又不会把没做过真机验证的工具面/前端改动直接发到 npm。

## 风险面（唯一来源：`scripts/dev/release-policy.json`）

- `prompt/**`（领域提示词）
- `worker/**`（Python worker）
- `toolsets.json`（工具面）
- `client.js`（前端半：插件页配置表单、会话芯片、turnTail 门禁面板）
- `package.json` 的 `engines.dsh`（宿主版本下限）

改这个清单要同时改 policy 文件、本 skill 和 `docs/development.md`。

## 必须先跑完的验证

1. `pnpm verify:all` 全绿。它覆盖 typecheck/build/全部单测/manifest/docs/private/tools/pin，
   以及需要 `uv sync` + 外网的 `check:worker`、`check:grounding`、`check:surface`。
2. 涉及 prompt / 工具面 / worker：加载 skill `vt-parity-check`，对照上游 Vibe-Trading 检查漂移，
   把结论写进提交正文。
3. 真机会话 smoke（`docs/development.md` §4、§5）：至少覆盖受影响场景——`/vibe-trading on`、
   调用相关工具、数字门禁（`report_figures`）跑通；按场景矩阵选取，不必全跑。
4. 前端（`client.js`）没有自动验证手段：必须在本地真实加载插件后打开 DSH Web 页面，检查
   插件页「配置」表单、会话芯片、turnTail 面板是否正常；可用 skill `agent-browser` 截图并读控制台报错。
5. 任何一步失败或跑不了（缺 uv、无外网、没有宿主、无法打开页面）→ **不要写 footer**。

## Footer 写法

放在提交正文最后，证据简短、可复核：

```
Release-Gate: verified (verify:all; parity; smoke: activation+options_pricing; ui: plugin config + chip)
```

`release.yml` 只认 `Release-Gate: verified` 前缀；括号里的内容建议包含：跑了什么、覆盖了哪些场景、
前端看了哪些页面。

## 跑不了 / 已经被拦住怎么办

- 还没提交：先跑验证；跑不了就如实告诉用户，由用户决定是否人工验证。
- 已提交但缺 footer：补一条记录提交（不改历史）：
  `chore: record release gate for vX.Y.Z` + footer。
- 用户明确要求跳过：在 Actions → Release → Run workflow 里带 `force=true`（绕过 gate，风险自担），
  或先合入带 footer 的提交再让自动流程继续。

## 别做的事

- 不要为了过钩子写 `Release-Gate: verified` 却没跑验证；release notes 与提交记录会留下它。
- 不要用 `--no-verify` 绕过钩子后直接推 main：`release.yml` 仍会拦。
