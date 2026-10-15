# 预设协同（2026-10-09 候选树记录）

本目录保存的是 **2026-10-09 只读候选树**（`/Users/diwu/.codex/worktrees/components-slice-20261007/dcode`）在「Pi 预设供应商 ＋ 在线公共目录 ＋ 保留自定义」上的归档证据，不是主目录本身的验证记录。

## 当前状态（已更正）

候选树当时的记录写的是「本候选尚未集成到 main」。该状态已于 **2026-10-10** 改变：主目录按冻结清单逐项接入了这批实现。

- 主目录实际接入范围、并轨方式、真实检查出口与未实现边界，以 **[模型目录接入（2026-10-10）](../模型目录接入-2026-10-10/README.md)** 为唯一正式记录。
- 候选树的叙述性记录（交付行为、根因收口、上游依据）仍在只读候选树内：`/Users/diwu/.codex/worktrees/components-slice-20261007/dcode/doc/验证记录/预设协同-2026-10-09/README.md`。该文中的「尚未集成到 main」只对候选树当时成立，主目录不复制这份原文，以免把已过时的状态写成现状。

## 这里的证据是什么

`evidence/preset-catalog-path.json` 是候选树端到端场景的步骤记录，覆盖：认证卸载取消 → 应用预设发出请求（`gpt-4`）→ 换用目录新模型 ID 发出请求（`gpt-4o-2025`，含 `maxTokens`）→ 预设之后自定义配置存活 → 目录换源生效 → 重开后仍可发送 → 重开后新模型 ID 仍可发出 → 冷重开后切回自定义 A 仍以 A 的模型发出。

它是**候选树**的证据。接入主目录后，界面与状态的真实运行证据由 `test/e2e/evidence/runs/provider-e2e-full/`（exit 0，70/70）及相关运行目录承担，`doc/验证记录` 保持只读历史。

## 冻结依据

- 冻结清单：`/Users/diwu/Workspace/Archives/dcode-provider-catalog-2026-10-09/verified-candidate-manifest.json`（32 项增量、8 处人工合并、1 项排除）
- 接入前回退点：`/Users/diwu/Workspace/Archives/dcode-prototype-implementation-2026-10-10/main-before-provider-integration-20261010-1917/manifest.json`
