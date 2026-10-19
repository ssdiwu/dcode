# ZCode 交互组件借鉴

本页保存2026-10-07的固定组件研究：来源[`29628c9`](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e)，没有运行上游、安装依赖或移植代码。当前交互唯一正文为[页面与交互组件](../spec/页面与交互组件.md)，实际采用/许可见[第三方材料](../THIRD_PARTY_NOTICES.md)，不从本页推断当前main缺陷。

## 值得保留的实际消费者判断

| 参考范围 | 实际来源与取舍 |
|---|---|
| 基础输入/浮层 | ui/input-group、dropdown-menu、dialog、popover为候选；共享原语优先从其维护上游取，适配D Code token、焦点、Esc与no-drag，不整搬业务 |
| 主按钮 | 真正链为ConversationComposer→ChatPromptEditor的submitControl；通用PromptInputSubmit在该固定src仅见定义，不等实际会话消费者。借同位按钮，不把Stop或Esc停止变为D Code暂停 |
| 时间线滚动 | 真正消费者是ConversationTimeline的独立视口、流式尾部、锚定和sticky输入dock；未证通用ai-elements/conversation被它直接使用。换组件不能算贴底/阅读问题已修 |
| 工具/消息 | ToolSummaryRow/ToolCallBody及实际MessageResponse可借摘要、正文与展开；按正式Pi结果适配，不搬审批或把工具结束当验收 |
| 分栏/差异 | resizable实际依赖react-resizable-panels，业务外壳另有分隔条；先比较已有布局。文件选择、只读diff与来源保在D Code，不扩Office预览 |
| 任务/归档 | 借任务行菜单、归档列表及查看/恢复；不搬永久删除/清空或路径替身份 |
| 快捷/设置/终端 | 借键盘结构与反馈；不把TaskFindDialog误作任务导航，不复制账户/支付，终端标签保留不证明进程恢复 |
| 协作图 | 只取节点、关系与详情阅读，不搬拖线派工、workflow调度或第二事实源 |

固定来源中ui目录43个TSX、ai-elements45个，混有品牌、预览及本地扩展，并非可搬原语数量；当时根src另有111个TSX也不是全部业务组件。完整枚举可由固定Git `36a26048` 本文件及[上游目录](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components)回查，日常只维护实际候选的消费者。

## 不随参考采用

不搬品牌图形、用户审批/权限模式、workspace tabs、系统多窗口、固定侧聊栏、永久删除、登录套餐支付、流程编辑器、后台错峰任务或默认媒体/Office专用能力。普通确认弹窗原语仍可服务真实确认动作，不等产品审批体系。

## 来源与复评

固定根LICENSE为Apache-2.0；copied-components记录shadcn MIT与ai-elements Apache-2.0，但原始导入revision未记录，referenceRevision不能当最初复制版本。实际导入应锁具体版本/文件并保声明，不能按目录名统称许可。

当时独立只读复核确认目录/实际调用/来源记录，未留报告阻塞；这只是研究资格，不是运行或移植通过。

新取用先明确既有缺口，保同一交互和状态所有者，再核键盘/焦点、双语、字号、窄窗及失败路径。只在实际组件消费者、现有缺口或来源/许可变化时重评；研究审查不等组件移植、视觉接受或产品验收。旧完整来源链接与逐项适配表可从Git `36a26048` 原路径回查。
