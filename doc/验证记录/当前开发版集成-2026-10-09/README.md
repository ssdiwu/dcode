# 当前开发版集成 · 2026-10-09

本次把已审的组件、内容清理、滚动补修及猫头鹰品牌接入主目录，版本统一为 **0.1.0 开发版**（`0.1.0-dev`）。当前入口是根目录 [启动 D Code.command](../../../启动%20D%20Code.command)，也可运行 `npm run desktop`。当前状态统一见 [PROGRESS](../../../PROGRESS.md)，功能变化见 [CHANGELOG](../../../CHANGELOG.md)。

## 来源、范围与回退

- 目标：`/Users/diwu/Workspace/Codes/Apps/dcode`，分支 `codex/redesign-2026-10-03`，HEAD `15917d1b58f6f7b244043911aa2457205308ddc3`，已有未提交修改。
- 固定来源：`/Users/diwu/Workspace/Archives/dcode-brand-owl-candidate-2026-10-08-r4/source`。这里的 r4 是内部证据身份，不是另一产品版本。来源 manifest SHA256：`f850d0f7462ec9ea159c1e030385d78c35e1a38a77cb758b5e74283d4d1d2685`，503 项来源文件均读回匹配。
- 将目标变动文件与最初组件基线逐项比较，未发现冲突。共接入 66 项：45 项替换、21 项新增；清单及逐项哈希在 [集成计划](integration-plan.json) 和 [执行结果](integration-applied.json)。
- 45 项原文件与恢复清单保存在 `/Users/diwu/Workspace/Archives/dcode-before-main-integration-2026-10-09-6334i0fc`。回退应依据 `restore-map.json` 逐项核对，不能覆盖之后的用户修改。
- 未用来源树覆盖主目录 AGENTS、DESIGN、GLOSSARY、README、PROGRESS、spec、已有证据、候选输出及正式品牌元数据；主会话另行维护本次入口和阶段文档。集成前进度已 [归档](../../阶段记录/2026-10-09-集成前进度快照.md)。

## 检查与补修

依赖由现有 lock 安装：`npm ci --ignore-scripts` 及锁定 Electron 的安装脚本均退出 0；日志见 [依赖安装](dependencies.log)、[Electron 安装](electron-runtime.log)。没有为图标引入新包或安装器。

首次单独架构检查发现 63 项，原始 [失败日志](before-architecture.log) 保留：62 项来自工具产生的根级 `.delta/worktrees/` 快照，1 项是历史诊断附件。处理范围如下：

- 架构策略与 Lint 仅排除根级 `.delta`。检查器实现未变；新增四条正反样例，验证快照可排除、产品引用仍拒绝、`src` 内同名目录仍受查、普通文档脚本仍拒绝。
- 旧诊断 `doc/验证记录/参考接续核对-2026-10-07/probe.mjs` 已调用移除的历史接口，将其保留为 `probe.mjs.txt` 附件。字节未改，SHA256 `144c81d1826343d4313bc67e874c6fa7e81735e2bf25f8d021ce0721e673140a`；原 source/result 记录保留，历史 README 说明该命令仅属当时证据。

| 检查 | 结果与边界 |
|---|---|
| `npm run verify` 架构 | 32/32 正反样例通过，当前产品源码通过 |
| 类型、Lint、构建 | 通过 |
| 运行与契约 | 31/31、4/4 通过 |
| 首次全量 E2E | **51/52**，见 [原始日志](verify.log)；唯一失败是 Pi 测试向不存在的历史证据目录写文件（ENOENT） |
| Pi 路径补修 | 改为测试自有 `test/e2e/evidence/pi-execution/` 并先建目录，未删除或放宽业务断言 |
| 定向复验 | `node --test test/e2e/pi-execution.test.mjs` **1/1 通过**，见 [日志](pi-path-recheck.log)；随后 [Lint](final-lint.log) 通过，没有重跑其余已通过用例 |

Pi 定向测试走完整的发送、正式接收、工具写文件、暂停、重开只读、显式继续、自然完成与助手正文保留路径；[自然回执证据](../../../test/e2e/evidence/pi-execution/pi-natural-observation.json) 显示恢复后由 `placed` 转 `done`，显式回查前后模型请求数均为 3。该证据为真实 Pi SDK 配受控模型，不是实际服务商验收。不能将首次全量结果改写为 52/52。

## 固定入口与实际界面

启动脚本固定使用主目录源码，并在启动前构建；数据在 `~/Library/Application Support/D Code Development/`，不删除旧目录或导入旧预览数据。脚本清除继承的测试装配环境，已有实例运行时不另建窗口。工程 package 与 lock 版本均为 `0.1.0-dev`。

实际执行根目录 `.command`，构建和启动退出 0，见 [启动日志](desktop-launch.log)。原生应用读取核实窗口标题为 D Code，页面来自 `file:///Users/diwu/Workspace/Codes/Apps/dcode/out/renderer/index.html`；进程记录为 PID 26871、主目录路径、`0.1.0-dev`。再次调用相同入口后 PID 未变，日志显示 [已在运行](desktop-reopen.log)，没有重建或再次打开窗口。

- [Home 实际截图](desktop-open.png)：侧栏猫头鹰、Home／默认任务、无默认示例历史；模型不可用提示、可编辑草稿、发送禁用。
- [关于页实际截图](desktop-about.png)：已选猫头鹰与 D Code 名称可见。查看后返回 Home，保留此开发窗口供 507 使用。
- 品牌母版和 renderer 副本均为 SHA256 `331e48812128520406aa8ef624da6e9b594dfe480e654080d7a605d0111c45e8`。侧栏及关于页已经视觉核对；现有运行时 Dock 图标通路已接入，未另做 Dock 像素核验，也未制作 ICNS、安装包或 Finder 应用图标。

自动 E2E 保持后台隐藏。实际打开是一个供用户体验的普通开发窗口，没有因此重跑可见自动化矩阵；界面读取和截图不等于用户接受。

## 独立审查与剩余边界

既有 `rea_ui_structural_review` 审查代理按 507-review 独立只读核对：66 项集成来源、原文件备份、后续五项必要差异、版本及依赖不漂移、启动器、品牌通路、架构样例、历史附件与真实测试结果，未发现阻塞。审查未修改文件、启动窗口或重复跑测试。

最终阶段文档另经只读复核：发现历史 PROGRESS 归档后的 14 个相对链接失效；主会话调整链接位置并注明正文保留、链接随位置调整。补修后独立复核确认链接及相关锚点有效，未发现剩余阻塞。

当前正常入口尚无真实模型服务商，不能承接真实开发执行；玻璃样稿尚未视觉接受或集成。正式要求中未完成的交互、协作、终端、选模和远端能力继续保留。此次没有提交、推送、合并 Git main、发布或新增工作树；当前两处本地 Git 工作树仍为主目录与组件实施树，远端本轮未重新核对。
