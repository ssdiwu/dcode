# 扩展同步模型目录消费者

2026-10-15。本片已完成必要完整检查及独立三项接收；原资源片与普通扩展／MCP的接受状态保持，父目标仍未完成。

本片只接普通扩展上下文的 chat `getAll/getAvailable/find`。原会话 ModelRuntime 继续拥有完整模型、认证和异步可用性发布；宿主在原消息快照内投影公开描述，线程同步读取完整／可用两个集合并返回独立副本，不从当前选中模型猜集合。公开描述不带执行 headers 或认证字段，原 canonical 模型继续发实际 SDK 请求。没有新增请求循环、存储、接收队列或模型探针。

基准为 `main-after-extension-resources-accepted-20261015/manifest.json`（459项目，canonical175/3dddf9175fc1c69c37e77c1d027a065b4c265d18236111737a6895050f84a2db），资源片纯结论登记已独立确认。固定Pi依赖仍为1.0.0，主目录原脏改动与MarkdownLite既定删除均保留。

## 实际路径与证据

公开 SDK 契约来自本机固定 ModelRegistry 实现：getAll→ModelRuntime.getModels，getAvailable→getAvailableSnapshot，find→getModel；完整目录不做认证过滤，可用目录有原认证／filterModels所有者。固定普通装配将 builtin chat 目录替换为空，再登记自有 A 和额外 B，所以本受控夹具完整目录可精确核 A+B0→A+B0+B1；这不是新增过滤。

外部证据根均在 `/Users/diwu/.codex/visualizations/2026/10/02/01a0fd5d-2c45-7783-bdeb-42ce2e19d2dd/`：

- `Root-catalog-target-red-r1-20261015`：原产品源上的真实扩展工具已进入原 SDK HTTP，getAvailable实际为thenable，目标断言失败，1条0pass1fail，真exit1，无timeout／skip／cancel。
- `Root-catalog-target-green-r2-20261015`：相同原三阶段资产，1/1真exit0；启动事件与正式工具可查未选B0，B新增B1刷新仍选A，明确选B1后实际B HTTP身份正确，A请求不增；工具JSON进入紧邻后续HTTP。安全目录去掉B自有测试请求头，同时B真实执行头正对照保持。
- `Root-catalog-auth-contrast-r3-20261015`：增认证不可用阶段的完整一条串行路径1/1真exit0；原目录仍含A/B0/B1、find仍能找到B，认证不可用集合只剩A；回A后的实际HTTP带该工具JSON，认证刷新／改选本身零请求。原assert/timeout未放宽。

每项有原argv、完整raw、数值exit与所指源码前后hash；check_run组件只提供耗时及hash，不虚构绝对起止时间。测试用隔离状态与本地协议对端，不读真实账户、Home、用户项目或付费模型。

## 完整门槛与独立状态

`Root-catalog-full-gates-r1-20261015/ledger.json` 已记录同一175/ad50ff7585c9af351f36c85e013774383163e4db7f91476c334efd9d17eb12d8下八门全部真exit0：架构正反32项、源码82、全类型／Lint／构建、runtime349/349、contracts13/13、完整隐藏E2E107/107，无fail/skip/cancel；各门原argv、绝对起止、真实数值出口、完整raw、前后map及整轮map一致。E2E经原外部lease串行运行，无前台或用户profile；本轮全部八门是同一driver新执行，不沿用此前资源片的门槛。

固定源码候选460文件／9聚焦证据已独立核hash，限定Spec／CodeQuality PASS、无必要源码发现；报告为`Root-catalog-source-independent-review-20261015.md`（11488bytes/ec7fa2d91a520fabb8f424efb4ea89159d42970cfda2f7eb4cc97601142a6f93）。最终Standards／Spec／CodeQuality三项PASS，无本片必要剩余；460项目与140公开证据全hash独立一致。最终报告`Root-catalog-final-independent-review-20261015.md`（10710bytes/65960b6a4dad365c0ec613984876a59efe6c3bfa068f9b383fbb7ba3ef2a641d）保留原pending报告，未重跑检查。

## CLI 辅助与边界

依507当次授权，ZCode新只读session `sess_2ae0a646-2de1-4124-83bc-2b8d7d4eb8c4` 实际完成固定旧副本Read5/Grep3并exit0；MiniMax通过mmx完成一次固定去敏源码分析并exit0，没有自主工具循环。B下`cli-assist-receipt.public.json`及`cli-assist-independent-corrections.public.md`保留实际执行与候选错误校正，原私密stderr0600不复制。只采纳本机源码确认的契约判断，不拿CLI输出替正式独立审查。没有安装、配置、模型／effort、账户、产品或真实服务商探针变更。

主动模型执行、typed目录、provider/virtual登记、消息／输入组合、事件／压缩／控制、exec、真实vision消费者及完整非界面父目标仍未完成；本片不声称它们通过。

## 已验恢复点与接续

已验完整恢复点：`/Users/diwu/Workspace/Archives/dcode-prototype-implementation-2026-10-10/main-after-extension-model-catalog-accepted-20261015/manifest.json`。产品、测试、配置与上述最终固定候选逐字节相同；仅PROGRESS、本记录和doc导航作结论登记，并新增最终独立报告证据。纯登记另核，不重复已绿行为检查。下一小片为扩展原工具任务内单次主动模型消费者；原普通MCP和资源片不重开。
