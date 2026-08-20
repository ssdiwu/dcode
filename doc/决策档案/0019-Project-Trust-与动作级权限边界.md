# Project Trust 与动作级权限边界

状态：Accepted（已接受；约束 `0.0.10` 及后续版本）

## Context（背景）

`0.0.9` 打开即接管后，D Code 打开会话即持有写入所有权，模型在会话内执行的 bash 命令与文件写入随之成为 D Code 名下的外部副作用——此前完全没有任何工具级询问。版本路线（`0.0.10`）与产品模型 0001（Permission Policy / Effective Grant / "本次允许 / 当前范围允许 / 拒绝" / 审计事件）早已预留此能力。Pi 0.84.1 没有内置审批 API，但 `beforeToolCall` 钩子被 AgentSession 桥接为扩展 `tool_call` 事件（异步可挂起、返回 `{block, reason}` 拒绝），Host 注入 inline 扩展（`dcode-fast` 模式）即可实现闸门。

## Decision（决定）

1. **闸门位置**：权限判定完全在 D Code Host 内——打开可写会话时注入隐藏 inline 扩展 `dcode-permission`，监听 `tool_call`：读取类工具（read / grep / find / ls）直接放行（沿用 0.0.4 Source Folder 授权根语义）；bash 与文件写入先查授权表；未知 / 自定义工具一律询问。Pi CLI 完全不受此闸门约束——这是诚实降级边界，如实告知用户"D Code 内的动作有门禁，Pi CLI 内没有"。
2. **授权语义**：grant 按"会话工作目录"为域持久化于 `agentDir/pi-dcode/permissions-v1.json`（版本化文档 + 原子写，沿用租约目录先例）。bash 按命令前缀（程序名 + 已知子命令词，如 `git push`、`npm test`），前缀后必须是结尾或空白；文件写入按授权根内整体放行。**项目外写入与自定义工具不支持范围授权**——每次只能"本次允许"或"拒绝"。高风险命令（rm、dd、git push、`curl|sh`、sudo 等）只是卡片呈现上的高险标记，不改变询问规则（反正都会问）。
3. **默认策略**：读取放行；写入与命令一律先问，命中 grant 才自动放行（审计记 `autoAllow`）。没有全局"永不询问"开关。
4. **请求生命周期**：闸门在工具调用处异步挂起并发 `permission.request`（工具、摘要、目标、风险分类、范围提示）；Swift 权限卡三键回传 `permission.respond`（allowOnce / allowScope / deny）。会话关闭或冲突时全部未决请求以"会话已关闭"拒绝结算，工具收到 block 结果，不悬挂。
5. **管理与审计**：设置页"动作权限"列出全部 grant（可单条撤销，撤销后同类动作再次询问）与最近 200 条决策审计（时间 / 会话 / 工具 / 摘要 / 风险 / 决策）。撤销与授权变化经 `permission.updated` 事件同步各窗口。
6. **协议**：新方法 `permission.respond` / `permission.list` / `permission.revoke`、新事件 `permission.request` / `permission.updated`、新能力位 `permissionGate`；App 与 Host 版本锁同步发布。

## Consequences（影响）

- 模型的每条 bash / 写入在 D Code 内都有显式门禁；重复动作按前缀 / 授权根收敛，打断次数有限。
- 授权文件属于 `~/.pi/agent/pi-dcode/`（与租约同域），本机多窗口共享同一事实源，刷新时重读。
- "当前范围"以会话 cwd 为域，不是 DCodeProject 聚合域——项目级汇总授权留待 Project Trust 后续演进。
- 闸门只约束 D Code Host 内的工具执行；扩展自带工具也经过 `tool_call` 闸门（未知工具一律询问）。

## Rejected Alternatives（未采用方案）

- **项目内 Bash 整体授权（一次允许后任意命令）**：接近无限期全局授权，违背路线反目标。
- **整条命令精确匹配**：几乎每条新命令都询问，安全感没有增加、打断最大化。
- **所有工具（含读取）先问**：与已交付的授权根只读预览语义冲突。
- **在 Swift 侧拦截**：工具执行在 Host / Pi 进程内，Swift 看不到执行前时刻，无法真正阻塞。
- **操作系统沙箱承诺**：明确反目标，不做。
