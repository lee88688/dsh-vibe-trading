# 安装挂起复盘（install hang postmortem）

> 时间：2026-11-06 20:04 首次 `install_bundle`，20:18 用户被迫重启，22:06 再次反馈。
> 影响：桌面 profile 的插件安装操作永不结束，Electron 宿主卡住约 2 小时。
> 结论：**已定位并修复**，且新增了不能再犯的自动校验。

## 1. 现象

- 我在会话里调用 `plugin_manager install_bundle`（target = 本仓库目录）。
- 之后工具调用一直没有返回，界面停止响应；用户重启后才恢复。
- 重启后 profile 里已经出现 `link:` 依赖与 bundle 条目，说明**安装本身已经写盘成功**。

## 2. 证据

`%APPDATA%\@deepseek-ai\dsh-desktop\plugin-operations\operations.jsonl`：

```jsonc
// 我们的操作只有 started，没有 settled
{"operation":{"target":null,"stage":"install","phase":"started","time":"2026-11-06T12:04:40Z"}}
```

三个 pnpm 操作日志里，最后一条（20:04:41）是完整的：

```
Already up to date
dependencies:
+ dsh-vibe-trading 0.1.0 <- <repo checkout>  (path redacted)
Done in 358ms using pnpm v11.28.5
```

也就是说：**pnpm 依赖安装 358ms 完成，挂起发生在之后的“应用/激活”阶段**
（plugin_manager 的 `enable` → `application: applied` 那一步）。

## 3. 根因

当时的 `cordis.patch.yml` 除了插入插件行，还**覆盖了宿主的 `sandbox-policy` 行**：

```yaml
# 旧版（已删除）
- id: sandbox-policy
  config:
    additionalWritableRoots: [!!js "..." ]
    workspaceRoot: !!js process.cwd()
    ...
```

两个机制叠加导致卡死：

1. **覆盖替换而不是合并**：Loader 补丁方言中，带 `id` 的补丁会**整体替换**该行 `config`
   （`cordis-composition-reference` 明说 “`config` is replaced wholesale, never
   deep-merged”）。`sandbox-policy` 是宿主核心服务，它需要的其他字段缺失 →
   服务在激活期无法就绪。
2. **重新加载宿主能力行本身有风险**：`sandbox-policy` 被
   fs-sandbox / bash-sandbox / pwsh-sandbox / tool-fs 等消费；重载它等于在会话里
   重启一套基础服务，而当时“安装”这次工具调用本身还挂在同一个进程里，形成相互等待。

一句话：**插件不该改宿主核心行**。

## 4. 修复

1. `cordis.patch.yml` 只保留一行 `insert`（插件自身），不再覆盖任何宿主行。
2. 运行目录 I/O 改走 **Vibe-Trading 自己的 `read_file` / `write_file`**：
   它们运行在 Python worker 里，不受 DSH 文件沙箱限制；新增 `runio` 工具组按需加载。
   → 不再需要 `additionalWritableRoots`，也就不需要碰 `sandbox-policy`。
3. `scripts/validate/check_manifest.mjs` 新增回归校验：
   补丁里**不允许出现**除插件自身之外的任何行 id，也不允许出现
   `- id: sandbox-policy`；任何“顺手改宿主配置”的改动会让本地校验直接失败。
4. 安装前先用**独立 profile + overlay 补丁**做无副作用激活验证（见下）。

## 5. 验证方式（以后装插件都先跑这一步）

`dsh` 支持 `--patch <file>` 叠加一层补丁，且补丁里可写相对路径（相对补丁文件定位），
所以可以**完全不安装**就验证插件的组合与激活：

```yaml
# test-overlay.yml（用完即删，已加入 .gitignore 语义）
- insert:
    - id: dsh-vibe-trading
      name: ./dist/index.js
      config: {}
```

```powershell
dsh --profile headless --patch .\test-overlay.yml --dump-config   # 行是否被正确组合
dsh --profile headless --patch .\test-overlay.yml "reply with OK"  # 是否真的能激活
```

实测输出（修复后）：命令 ~1s 返回，唯一的错误是没有模型凭据
（`MISSING_CREDENTIAL`），说明**插件激活阶段没有挂起**——这正是当初出问题的阶段。

## 6. 残留风险与注意

- 覆盖宿主行仍然可能被其他人写进别的补丁；回归校验只保护本仓库。
- `plugin_manager` 的安装操作如果再次长时间不返回，先看
  `plugin-operations/operations.jsonl` 有没有 `settled`，再看
  `.plugin-manager/logs/operation-*/pnpm.log` 是否完成：pnpm 完成而操作未结束 ⇒
  问题在激活阶段，而不是网络/依赖。
- `link:` 安装不会执行 `prepare`/`build`，**装之前必须先 `pnpm build`**（`dist/` 不提交到仓库）。


---

# 第二次事故：激活“成功”但一个工具都没注册（2026-11-06 23:26）

## 现象

用户在会话里执行 `/vibe-trading on`，命令返回：

```
Vibe Trading 已激活：5 个常驻工具 + 4 个网关工具
工具目录 127 个（8 个工具组）、技能 89 个
注册工具 vt_load_skill 失败：tool "vt_load_skill" must declare output { schema, render, presentationMeta? }
```

随后模型回答某 A 股标的的行情/业绩问题时，调用 `search_symbol` 得到
`Error: unknown tool "search_symbol"`（`ToolNotFoundError` / `UNKNOWN_TOOL`），
于是模型只能自己用 `pwsh` 翻 `site-packages` 源码去查——用户看到的"一直在调用命令、
工具没用上"就是这个原因。

## 根因

1. **DSH 工具注册要求声明 `output`**（`{ schema, render, presentationMeta? }`）。
   我们的工具定义只有 `name/description/inputSchema/execute`，注册被 registry 拒绝。
2. 我们的激活代码**逐工具 catch 失败**，但：
   - 提示语把工具数写成硬编码的 "5 个常驻 + 4 个网关"；
   - `notice` 每次被覆盖，只显示最后一个失败（`vt_load_skill`），看起来像"只挂了一个"。
   实际 9 个全部未注册。

## 修复

- 新增 `src/lib/tool-output.ts`：`TEXT_OUTPUT = { schema: { type: 'string' }, render: (_a, v) => [{ type:'text', text }] }`，
  所有工具（setup / 5 core / 4 网关）都声明它。
- 激活结果如实返回：`toolCount` / `failedCount` / `failures[]`，命令与 `status` 显示真实数量，
  失败原因逐条写入 `logs/plugin.log`。
- 新增回归测试：activate/gateway/setup-tool 的每个 definition 必须有 `output.schema` + `render`。

## 验证

`dsh --profile headless --patch scripts/dev/test-overlay.yml ...`（无副作用加载插件）：

```
apply: start
apply: vibe_trading_setup registered
apply: /vibe-trading command registered
```

`vibe_trading_setup` 与代理作用域工具走同一个 registry 校验，因此这次能注册成功即说明
`output` 契约正确。

## 经验

- DSH 的 `ctx.tools.register` 不只是"塞一个对象"：`output` 是硬性契约；
  注册失败会在 apply/激活期抛错，**必须把失败计数报给用户**，不能只留最后一条。
- 调试这类问题的快捷方式：`dsh --profile headless --patch <overlay>` 启动一次，
  看 `~/.vibe-trading/dsh/logs/plugin.log` 的 apply/注册行，不用装 profile、不用开 GUI。
