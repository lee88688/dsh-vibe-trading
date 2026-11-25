# 文档索引

> `docs/` 只放**对外可读、当前仍然成立**的文档。任务/待办用 GitHub Issues；历史过程记录不进 docs
> （git 历史保留，唯一例外是 postmortem）。新增/改名/删除文档时同步更新本索引；相对链接由 `pnpm check:docs` 校验。

## 文档地图

| 文档 | 类型 | 内容 |
|---|---|---|
| [../README.md](../README.md) | 入口 | English README：项目简介、安装、设计、限制 |
| [../README.zh-CN.md](../README.zh-CN.md) | 入口 | 中文 README：项目简介、安装、设计、限制 |
| [../AGENTS.md](../AGENTS.md) | 交接 | 跨会话上下文：规则、环境、代码地图、调试、测试入口 |
| [architecture.md](architecture.md) | 设计 | 设计事实：边界、架构、命令、worker、工具、技能、提示词、沙箱、预算、失败模式 |
| [tool-surface.md](tool-surface.md) | 参考 | **工具面对照表**（生成物）：已暴露/DSH 接管/需凭据/直接禁用，逐工具附理由；升级 VT 时按 §8 维护 |
| [decisions.md](decisions.md) | 决策 | 已定设计决策（D1–D28），被取代的决策保留原文 |
| [number-verification.md](number-verification.md) | 机制 | 数字核实三层机制（identity / evidence / figures）与展示层 |
| [data-sources.md](data-sources.md) | 参考 | 行情数据来源、失败原因、用户侧配置与排查 |
| [development.md](development.md) | 开发 | 本地环境、校验命令、真机验收、真实会话测试、场景矩阵、发版 |
| [postmortems/install-hang.md](postmortems/install-hang.md) | 复盘 | 安装挂起事故的根因与回归防线 |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | 贡献 | 环境、校验、改动范围、PR 约定 |
| [../SECURITY.md](../SECURITY.md) | 安全 | 漏洞报告、信任边界、凭据处理 |
| [GitHub Releases](https://github.com/lee88688/dsh-vibe-trading/releases) | 变更 | 每个 tag 的发布说明（由 workflow 自动生成） |
| [../THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) | 许可 | 上游 Vibe-Trading 的 MIT 声明与改编范围 |

## 维护约定

- **常青 vs 一次性**：设计/机制/参考文档不带日期；一次性审计、测试结果、里程碑记录不进 docs
  （放 git 历史、Issue 或 PR）。只有 postmortem 作为长期工程记录保留。
- **任务与待办不写进 docs**：用 GitHub Issues；文档只记录“当前仍然成立”的设计、机制与结果。
- **实测数字**：稳定的性能/预算基线写进 [`architecture.md`](architecture.md) §11.1，开发/测试数字写
  [`development.md`](development.md)；不再单独维护 measurements 文档。
- **个人内容不进 docs**：个人研究/与项目无关的笔记放仓库根 `_personal/`，个人 skill 放 `.dsh/skills/`
  （均已 gitignore）；规则见 [`../AGENTS.md`](../AGENTS.md) 第 14 条。
- **相对链接必须可达**：`pnpm check:docs` 扫描 `README.md`、`AGENTS.md`、`plugin-page.*.md`、`docs/**/*.md`。
