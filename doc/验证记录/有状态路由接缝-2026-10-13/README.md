# 有状态路由接缝验证记录

2026-10-13：Root 作为主树唯一写入者，在已验必要 D1 修复上完成条件 ModelRuntime→同一 Durable 接缝；限定独立审查 Standards／Spec／CodeQuality 三项 PASS。本记录只接收该接缝，普通 custom／preset 入口尚未切换，整个编码路径和产品尚未完成。

## 已接收行为

正式 Generation hook 依据 Durable 的输入、任务和准备点区分 user／continuation／retry；循环外 completeSimple 为 direct，不读取或推进会话路由状态。每条会话、虚拟身份分别保留状态。请求计划与返回状态由同一公开 Harness 事务保存；可靠保存拒绝时没有半份采用或 HTTP。

关闭重开只读不发请求，同一已保存 task／attempt／cutoff 的明确继续复用原计划，不重复 resolve、接收输入或完成的写文件。迟到选择结果重核当前正式配置；物理模型的已知上下文和输出上限在本次请求前核实，不以虚拟展示容量发送超限探测。发出前的虚拟失败不发布成物理来源或用量。

Deferred 消费者保存原 checkpoint 调用身份与真正返回的物理句柄归属；改选以及 pending 回查更新句柄资料后，poll／cancel 仍落到实际 B。公开 Storage 的准备点读回证明新句柄已保存，随后才暂停、重开、继续或 abort。此证据使用公开 Provider 合同和隔离 HTTP 作业，不宣称 builtin 或真实服务商支持 deferred。

## 版本和检查

有效行为源：canonical **148/f659a62c74c78d38575dc586f4ea98620a3a3d2022ccfb4ba9774455c1b943d3**。2001 固定候选和 2010 记录收口副本共有 424 项目文件；2010 只改 PROGRESS 一句检查时态，产品、测试、配置及 canonical 清单相同。

| 检查 | 实际结果 |
|---|---|
| 架构正反样例／源码检查 | 32/32；70 个源码文件；各真 exit0 |
| 全范围类型／Lint／构建 | 各真 exit0 |
| Runtime／契约 | 247/247；10/10；各真 exit0 |
| 完整隐藏串行 E2E | 97/97，无 fail／skip／cancel；真 exit0 |
| 新14场景＋原恢复／生命周期定向 | 27/27；真 exit0 |

最终八门起止为 2026-10-13 19:55:30–20:00:30（+08:00），总前后和每门前后完整源码清单同源。台账保存每条原命令、数值出口、完整 raw、起止与身份，没有用外层成功替代子命令出口。

## 原反例与限定收口

未发出虚拟归属、物理容量、改选后的 deferred、direct 容量错误结果合同、pending 更新句柄各有真实目标红。pending 原红为一条失败，第二次回查预期2、实际1；修后同原作业完成，不重建或推进状态。其余已通过路径保留。

第一轮完整 E2E 的 97/96/1 红是 F3 实际 gutter=0、在经典 thumb 拖动前拒绝；未当作业务拖动失败或路由回归。该场景随后只在测试进程易失参数域固定经典滚动条，没有写用户系统偏好，原拖动／滚轮／键盘／草稿强断言及 timeout 不变，定向10/10与最终全量均通过。

句柄补证中两次取消夹具失败照实保留：一份空请求体解析异常，随后一份将 Harness.inspect 状态摘要误当 TaskRecord。有限诊断确认正式 poll checkpoint 已更新；改用公开 Storage.scanTasks 核前置，未知 HTTP 路径分别拒绝，未完整模型正文不生成假成功。没有把目录名中的 green 当作通过，临时诊断已移除。

## 证据位置与边界

外部协调目录：`/Users/diwu/.codex/visualizations/2026/10/02/01a0fd5d-2c45-7783-bdeb-42ce2e19d2dd`。

- 最终门槛：`Root-runtime-renewed-deferred-final-qualified-gates-20261013/ledger.json`。
- 定向最终：`Root-runtime-renewed-deferred-qualified-checkpoint-green-20261013/receipt.json`。
- 最终独立报告：`Root-runtime-renewed-deferred-final-independent-review-20261013.md`，SHA-256 `4581f0e0fa6dc8660ffa9876434a54188630d8960e74137c89ee872eac7d24e8`。
- 固定行为候选：`/Users/diwu/Workspace/Archives/dcode-prototype-implementation-2026-10-10/main-runtime-renewed-deferred-final-review-candidate-20261013-2001/manifest.json`，236 公开证据逐 hash 记录。

本片只对显式注入 ModelRuntime 的 Harness 激活。普通入口、项目资源、真实工具成果 UI、旧普通运行目录保全仍按下一阶段接线验收；真实账户、服务商支持、人工视觉、提交和发布各自成立。没有换引擎、升级 Pi、恢复停写作者或额外产品权限模式。
