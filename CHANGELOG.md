## [0.0.19] - 2026-08-22

### Added

- 失败与恢复加固（ADR 0027 / PRD 0020）：中断影响按 已完成 / 未完成 / 未知 三态呈现，恢复一律用户显式触发。Host 重连——意外退出或 `host.restartRequired` 后，侧栏与主页空态提供"重新连接 Pi Host"（复位传输层、保留会话 / 草稿 / 队列 / 账本内存状态，ready 后刷新列表并尝试以可写重开当前会话，run `.unknown` 如实保留），不再需要重启应用。半条 JSONL 受控修复——`session.open` 对尾部不完整会话的 `INVALID_SESSION` 附带 `repairable`，界面呈现修复卡，[备份并修复后打开] 经新增协议命令 `session.repair` 执行（同目录完整备份 `.bak-<uuid>` → 临时文件修剪尾部不完整记录 → 严格读取器复验 → 原子替换）；仅当其余记录完好时可修，其余形态拒绝且原文件零改动。协议新增 `session.repair`。
- promptId / steerId 幂等（ADR 0027 决定 5）：Host 维护会话级已见 ID（LRU 256），重复提交返回诚实错误 `SESSION_DUPLICATE_PROMPT` / `SESSION_DUPLICATE_STEER`（details 附已关联 runId），不再可能重复执行；Swift 的"安全重试"条件不变（仍要求 Host 判定未持久化，且重试使用全新 ID）。
- 本机存储熔断可见化 + 显式重试：五个本机 store（会话草稿 / 会话变更账本 / 后续消息队列 / 活动关注 / 验证证据账本）暴露熔断探测与用户显式重试（重新 load 校验或立即补写）；设置 › Host 诊断 新增"本机存储状态"区（正常 / 熔断 + 路径 + [重试保存]）；会话草稿熔断在 Composer 常驻提示；验证证据区新增熔断提示条与[重新载入]，"revision 待补"区分补全中 / 账本暂停，证据账本熔断期间的内存记录在恢复后补写。
- 恢复链路去静默：自构建重启后恢复会话失败出现 notice 并提示手动打开；移除 Source Folder 时提示受影响范围（失去授权的文件标签数与不再归属原项目的已加载会话数）。
- Host SIGINT 与 SIGTERM 同走 graceful shutdown；新增 [ADR 0027](doc/决策档案/0027-中断状态可辨认与恢复边界.md) 与 [PRD 0020](doc/40-版本实施方案/0020-0.0.19-失败与恢复加固产品需求.md)。
- 将 App / Host / Info.plist / build.sh 开发版本统一提升为 `0.0.19`（本轮起 Host `HOST_VERSION` 常量纳入提版清单）。

## [0.0.18] - 2026-08-22

### Added

- HTML 编辑缓冲区与隔离即时预览（ADR 0026 / PRD 0019）：`.html` / `.htm` 文件打开即进入"编辑缓冲区 | 即时预览"并排双栏（窄窗口上下堆叠），编辑、⌘S 保存、磁盘冲突三选、关闭与放弃确认完全复用 0.0.17（ADR 0025）的缓冲区与原子保存模型。预览为项目首个 WKWebView（NSViewRepresentable）：nonPersistent 隔离存储、内容从内存缓冲区注入（编辑停顿约 400ms 自动重注入，头部如实标注"跟随未保存缓冲区"）、内联脚本默认运行（用户裁决，取代原型"未开放脚本权限"文案）；网络默认阻断（内容规则拦全部 `http(s)` 子资源、外部导航一律拦截），导航尝试触发"本次允许 / 保持阻止"询问条——放行仅当前文件预览会话有效，切换文件或回到对话即恢复阻断，子资源因 WebKit API 限制以常驻状态呈现（不伪装逐条批准）；本机相对资源经自定义 `dcode-asset://` scheme 回到 Swift，复用安全路径（逐级 `openat`、拒符号链接、限 Source Folder 授权根、单资源 8MB 上限）读取，越界请求直接失败。不提供地址栏 / 前进后退 / 自由浏览，不做浏览器。
- 新增 [ADR 0026](doc/决策档案/0026-HTML-隔离即时预览与网络询问边界.md) 与 [PRD 0019](doc/40-版本实施方案/0019-0.0.18-HTML-编辑缓冲区与隔离即时预览产品需求.md)；设计系统 §7.4 补 HTML 双栏与联网策略条款。
- 将 App / Host / Info.plist / build.sh 开发版本统一提升为 `0.0.18`。

## [0.0.17] - 2026-08-22

### Added

- Markdown 编辑缓冲区与安全保存（ADR 0025 / PRD 0018）：`.md` 文件标签提供 源码 / 预览 分段切换——预览默认渲染缓冲区文本而非磁盘事实（未保存时明确标注），源码态未进入编辑时保持 0.0.4 行号只读呈现（行定位请求优先源码态）、进入编辑后为等宽编辑器。保存（⌘S，作用于当前选中标签）走与读取同一套安全路径（逐级 `openat`、拒符号链接、限授权根）：同目录 `O_EXCL` 临时文件 → `fsync` → `renameat` 原子替换（精确保留原权限位）→ 目录 `fsync`；写入前重读磁盘校验内容 SHA-256 与基准一致，不匹配即冲突拒绝。磁盘冲突以冲突卡三选裁决（重新加载磁盘版 / 显式覆盖保存 / 继续编辑，继续编辑后普通保存仍被拒绝）；关闭有未保存修改的标签必须确认（保存并关闭 / 不保存 / 取消），“停止编辑”放弃修改同样确认；标签与标题栏常显脏标识，授权撤销后缓冲区保留可编辑但保存禁用；App 重启如实丢弃缓冲区，不建持久草稿。
- `app/build.sh` 新增发布打包硬性检查：工作区不干净（`git status --porcelain` 非空）时拒绝构建，可用 `PI_DCODE_ALLOW_DIRTY_BUILD=1` 显式做本地调试构建（产物不得当作发布物分发）；`app/Info.plist`、`host/package.json`、`host/package-lock.json` 三处版本号不一致时拒绝构建，无绕过项。构建产物新增 Git revision / describe 与工作区干净状态记录；HEAD 不在对应 `v<version>` tag 上时打印警告。`AGENTS.md` 补充对应交付前提。

### Changed

- 上下文圆环弹层对齐同类产品：主数字改为「已用 / 窗口」（如 `307k / 400k`）并保留剩余百分比；构成改为分段彩色条 + 图例一一对应（分项带 token 数与百分比）；新增压缩区——自动压缩阈值（按 Pi 语义：用量超过 窗口 − reserveTokens 时自动进行，缺省预留 16384，项目覆盖全局）与「手动压缩」动作（Pi 合同 `session.compact()`，会先中止当前操作；进行中沿用 0.0.15 的压缩状态呈现）。协议新增 `session.compactionInfo` / `session.compact`。
- 压缩弹层修复跨会话状态：阈值改为每次打开弹层重新请求（此前首次载入后不再刷新，切换 Project 仍显示前一目录的项目覆盖阈值）；运行中不再禁用「手动压缩」——与 Host「先中止当前操作再压缩」语义一致，按钮在运行中明确标注后果。
- `dcode_facts` 的 `changes.source` 判定改为生产值 `structured-tool-v1`（此前每条变更都被错误标注“来源非 D Code”）；project 归属匹配先解析符号链接再比较（对齐 Swift `ProjectSessionOwnershipResolver`，经符号链接打开的工作目录不再匹配失败）。Host 测试夹具改为 Swift 编码器真实字段形状（golden fixture）并新增符号链接归属用例。

### Docs

- 校准 `v0.0.16` 前后的文档与实现现状：版本索引拆分 Source（源码标签）与 Acceptance（验收），补齐 `v0.0.7–v0.0.16` 的远端标签状态并记录已知缺口；架构与分层 README 补入 `0.0.14–v0.0.16` 的主页 Composer、本机资源、自定义供应商、Self-build、验证证据等现实能力；已被 ADR 0018／0023 取代的"共享观察 / 按需写入""权限卡"等过期现状改写为历史基线记录，`0.0.15`／`0.0.16` PRD 中不成立的验收项重新取消勾选。
- 新增 ADR 0025（Markdown 编辑缓冲区与原子保存边界）与 PRD 0018（0.0.17 范围冻结）；版本演进、设计系统 0002（§7.4 文件标签编辑语义）与版本实施方案索引同步，已知缺口清单按 0.0.17 收口结果刷新。

### Fixed

- 自定义供应商设置不再回传或接受整体替换 `modelOverrides.<model>.headers`：此前该字段随 Provider 快照整体序列化进入 Swift 高级 JSON 编辑器，其中若含 token 正文即违反凭据脱敏合同；Host 现在始终原样保留既有 `modelOverrides`，界面移除对应编辑框。0.0.17 补 Host 嵌套脱敏断言（`modelOverrides.m1.headers.X-Token` 不出现在 `list()` 视图）。
- `models.json` 写入收紧并发边界：Store 内全部读写串行化（并发 save / remove / list 不交错，D Code 自身永不成为丢失更新的后写者），rename 前重读文件比对内容 SHA-256（解析基于读入内存的字节，解析对象 / 指纹 / 基准同源）——窗口从“整个编辑会话”缩到“校验与 rename 之间”；POSIX rename 无条件替换原语，跨进程最后间隙为文件系统协作边界，如实保留。并发写用例锁定。
- Composer `+` 的 Prompt 模板参数提示贯通：`resources.list` 的 `commands` 投影携带 `argumentHint`（扩展命令与 Skill 为 null），Swift 侧带提示的模板预填为 `/<name> <hint>` 占位——此前 hint 在投影中丢失，只插入 `/<name> `（0.0.16 审计 P1）。
- 删除自定义供应商后联动刷新 Model Settings 目录快照：此前被删 Provider 可在缓存中继续显示到下一次手动刷新（0.0.16 审计 P1）。
- 搜索正文命中打开加回归钉子并删除死代码：`openSearchResult` 断言以 writable + `expectedEntryId` 打开且不携带 `expectedEntryDigest`（Protocol v1 禁止该组合）；从未被生产调用的 `SessionOpenRequestPlan.searchResult(_:)` 移除（其 readOnly 形状曾误导审计）。
- 搜索正文命中消息现在可以正常打开：此前以可写身份打开会话时仍附带 `expectedEntryDigest`，被 Protocol v1 明确拒绝该参数组合（可写打开的新鲜度已由租约与静默窗口保证），导致命中消息实际无法打开。
- `dcode_facts` 的 `evidence` / `project` facts 改读 Swift 侧真实存储合同：验证证据账本按 `{version, records}` 与 `ok`/`failure`/`unknown` 三态退出码读取，项目登记改读 `projects-v1.json` 的 `{version, projects}`；此前读取的文件名、文档形状与生产不一致，导致这两类事实在真实环境下始终不可用，此前测试因夹具自造格式而误判通过。
- `host/package-lock.json` 根包版本回补并随版本提升保持与 `host/package.json` 一致。
- 会话前草稿（主页输入框）不再显示上下文余量圆环：此前圆环以禁用的空环形态常驻，但草稿尚无任何运行上下文；会话创建、存在真实上下文后才显示。
- 将 App / Host / Info.plist / build.sh 开发版本统一提升为 `0.0.17`。

## [0.0.16] - 2026-08-22

### Added

- 设置新增"自定义供应商"页（Pi `models.json` 合同）：新增 / 编辑 / 删除自定义供应商与模型定义；认证只写不回显（API Key 输入、OAuth radius、清除认证），既有凭据由 Host 合并原样保留，正文永不进入 D Code；保存前经 Host 结构检查 + Pi `ModelConfig` 真实校验双层把关，非法输入返回字段级错误且原文件零改动，合法变更原子写入并联动刷新模型目录；models.json 解析失败时如实呈现并拒绝编辑。
- Composer 控制行新增 `+` 一次性资源调用：按 命令 / Skill / Prompt 模板 列出 Pi 真实加载的资源（与 设置 > 本机资源 同源，主页草稿与会话内一致可用），选择即把 `/…` 调用写入当前草稿并聚焦——只预填不发送，实际采用的资源以草稿中可见的调用文本为准。
- 协议新增 `modelProviders.list` / `modelProviders.save` / `modelProviders.remove`。

### Changed

- 将 App / Host / Info.plist / build.sh 开发版本统一提升为 `0.0.16`。

## [0.0.15] - 2026-08-22

### Added

- 界面即上下文（ADR 0024）：信息检查器的文件行、Git diff 文件行 / hunk、验证证据行、会话谱系节点与计划工作项新增"引用到输入框"，把精确引用（路径、行区间、增删摘要、命令与 revision）写入当前 Composer 草稿并带回对话页——只预填不发送，已有内容以空行追加不覆盖。
- 上下文压缩可见（ADR 0024）：`HostState.isCompacting` 解码，压缩进行中在会话上下文行显示"正在压缩上下文…"状态 pill，结束即消失。
- 设置新增"本机资源"页：按 Pi 真实加载结果展示扩展包（可停用 / 启用）、已加载扩展（含注册的工具 / 命令计数）、Skill、Prompt 模板、命令与加载诊断；停用扩展包经 Pi `SettingsManager.setPackages` 真实配置写 + 资源热重载生效，原始条目影子保存于 `pi-dcode/disabled-packages.json` 以便原样恢复；Skill / Prompt / Command 无 Pi 配置合同，只读展示。
- 首个只读工具 facade `dcode_facts`（ADR 0024 决定 3）：注册进同一个 Pi Agent Loop，按需暴露 D Code 宿主独有的事实——当前会话的变更账本归因、验证证据、会话谱系与所属项目 Source Folder 集合；账本缺失或损坏时如实报不可用。
- 协议新增 `resources.list` / `resources.setPackageEnabled`。

### Changed

- 文件树行支持键盘：焦点行 accent 焦点环，目录行 → 展开、← 收起、回车触发行默认动作。
- 性能收口：只读文件预览的行切分由每次访问重算改为构造时缓存（消除大文件 O(n²)）；文件树子层、Git 变更列表与 diff 展开体改 LazyVStack 惰性构建；会话滚动的双 `Task.yield()` 硬等布局改为单一 runloop 跳转的下一帧滚动；行级可见性回写去重，滚动不再逐行触发顶层失效。
- 将 App / Host / Info.plist / build.sh 开发版本统一提升为 `0.0.15`。

## [0.0.14] - 2026-08-21

### Added

- 主页改为"落地即可打字"的会话前草稿：无会话打开时自动恢复或创建新会话草稿（默认用户目录 `~`），与 Composer 共用同一组件；启动、新建会话、打开会话与返回工作台时输入框自动获得键盘焦点；占位符改为教学式（`@ 添加上下文，/ 使用命令`）；新增作用域托盘（Source Folder chip 可换目录且正文保留，选中 Git 仓库目录时显示只读分支 chip）与输入框下方 2–3 条最近会话安静行——输入框保持画布几何中心，最近会话按实测高度做顶部补偿、不参与居中。延迟创建机制不变，且不再在界面上解说。
- 新增 ⌘N 新建会话快捷键；会话栏动词行行尾常显快捷键提示。
- 设置 > 外观新增"界面字号"（紧凑 / 标准 / 大）：经系统 Dynamic Type 语义整体缩放全部文本，标准档跟随系统，无障碍特大档不参与。
- 设置新增"Host 诊断"页：Host stderr 与扩展旁路输出的只读日志（200 条环形），用于排查连接与扩展问题。
- 会话轮次折叠态改为逐步安静摘要：完成后每步状态常显为一行次级色文字——相邻同类合并（`探索 · 3 文件`、`运行命令 · 2 次`、`思考过程 持续了 4 秒`），编辑 / 创建按目标文件聚合并显示目录与 `+1 −1` / 行数，失败步骤行内标注；超过 8 行以"另有 N 步"收口，展开仍是完整思考与工具过程。
- `/` 命令面板新增键盘导航：↑↓ 选择高亮、Esc 关闭、回车选中。

### Changed
（发布后补记，随 v0.0.14 tag 交付）
- Composer 占位符改用设计系统 3.4 新增的 hint 档（`tertiaryLabelColor`，约 `0.26`）并压回文案预算：`交给 D Code 一项工作，/ 使用命令`。此前占位符用 `secondary`（`0.5`，与次级元信息同档）承载分号并列的两条教学，实测墨色 127，对照同类产品的 168 / 197 明显偏重——空输入框第一眼读成"已经有内容"。改后实测 188，落在提示档。同时不再预告尚未实现的 `@ 添加上下文`：占位符只教已经实现的快捷输入。
- 设计系统补上此前缺失的规则：3.4 新增 hint（提示档）层级并写明 `placeholderTextColor` 在 macOS 上与 `secondaryLabelColor` 同为 `0.5`、不是提示档；7.6 给占位符加上视觉预算（一行、上限 18 个全宽字符当量、最多一条教学子句、不预告未实现能力）；9 验收矩阵新增提示档墨色采样。原先文档只规定占位符文案要"承担教学"，没有给它任何排版档位与长度预算，这是本次视觉问题的直接来源。
- 发送按钮改为"容器常在、权重分档"：暂不可发送时保留同尺寸的中性极低填充圆盘（`0.07`）与次级色 glyph，可发送时仍是 accent 圆形填充，并补上按压反馈（0.82 accent + `0.97` 缩放，Reduce Motion 下跳过）。此前禁用态容器是 `Color.clear`，只剩一个裸箭头飘在模型 chip 旁边——实测该行墨迹分布为余量环 791 像素 / 模型 chip 357 / 发送按钮 131，主动作是整行最弱的元素，用户找不到按钮在哪。新增共享 `SendActionStyle`（`DesignSystem.swift`），设计系统 7.6 同步改写为容器常在规则。


- 会话打开加载反馈：点击会话行立即进入选中态，主画布即时显示加载占位，消除数秒无反馈空白期。
- 发送按钮收进统一图标动作几何（28pt 视觉 / 32pt 命中区）：可用时 accent 圆形填充，禁用态只保留次级色 glyph、不再使用 36pt 实心灰盘；模型 chip 降为 caption 字号与次级视觉。
- 会话行时间戳从 Hover 详情提为行尾右对齐常显（caption / 等宽数字），位于真正的行尾；Hover / 键盘焦点时置顶与归档按钮在同一尾部槽位翻出覆盖时间（时间淡出但保留占位，标题截断边界不变）。
- 自构建设置页补齐页标题与卡片容器，与相邻设置页视觉统一。
- pi-di18n 等扩展的语言 / 本地化状态提示（`lang:…`、`i18n: …`，Pi CLI 中的 transient footer / 状态行，可能为 warning 级别）不再弹出顶部横幅，改入 设置 > Host 诊断 只读日志；普通扩展通知仍正常横幅。
- 将 App / Host / Info.plist / build.sh 开发版本统一提升为 `0.0.14`。

### Removed

- 移除动作级权限闸门（ADR 0023 最终形态：固定完全访问）：删除 Host 侧 `dcode-permission` 隐藏扩展、授权表与审计持久化（磁盘上既有 `permissions-v1.json` 不迁移不删除，仅不再读写）、协议 `permission.request/respond/list/revoke/setMode` 方法与 `permissionGate` 能力位，以及 Swift 侧权限卡、Composer 权限 chip 与 设置 > 动作权限 页。D Code 内的 bash、文件写入与自定义工具全部静默执行，与 Pi CLI 行为一致；不存在模式切换。

### Fixed
（发布后补记，随 v0.0.14 tag 交付）
- 修复禁用态发送按钮 glyph 被二次变暗的问题：代码写的是 `Color.secondary`（`0.5`），但 `.buttonStyle(.plain)` 叠加系统对 disabled label 的变暗后实测墨色 190，恰好与提示档占位符（188）同权重，等于文档规定的"次级色 glyph"从未真正生效。改由自定义 `ButtonStyle` 自己表达禁用观感后实测 121，回到次级档（新增离屏渲染回归用例，同时锁住容器不得消失）。
- 修复 Composer 占位符与输入正文靠手工偏移常数（`.padding(.top, 1)`）对齐的问题：占位符不再是叠在 AppKit 文本视图上的 SwiftUI 覆盖层，改由 `ComposerNSTextView` 自己绘制在 text container 原点，与真实首行共用同一套布局几何，界面字号切到紧凑 / 大档不再错位（新增离屏渲染回归用例，逐档比较占位符与真实输入的墨迹包围盒）。占位符同时通过 `accessibilityPlaceholderValue` 暴露，不再是装饰性覆盖层。


- 修复主页"无法读取 Pi 模型：(Swift.CancellationError 错误 1)"且模型停留在"未选择"的自取消回归：主页 `.task(id:)` 的 key 曾包含 `isNewSessionDraftActive`，草稿一激活 key 即变，SwiftUI 取消正在运行的任务，恰好掐断进行中的 `session.getModels` 并把取消误报为读取失败；重启的任务又因守卫直接返回，不再重试。修复：key 移除草稿状态；`CancellationError` 不再当作模型读取失败呈现（`loadRuntimeControls` 同类误报一并处理）；`ensureHomeDraft` 在草稿已在但模型从未载入时补一次加载（回归用例锁定该路径）。
- 修复主页落地即可打字机制引入的会话打开竞态：`ensureHomeDraft` 触发的 `createSession` 在自身挂起（本机草稿落盘）期间不重新检查状态，若此时并发的 `selectSession`/`openSession` 正在打开真实会话，`createSession` 恢复执行后会无条件清空当前会话呈现（含 `snapshotCommitGeneration`），导致刚打开的会话被静默清空、界面弹回主页且不提示任何错误；同一竞态也会让主页新草稿的模型选择被并发的 `clearActiveSessionPresentation` 重置且不再重试，长期停留在"未选择"。修复为 `createSession` 在挂起点前后各拍一次快照（是否已有会话打开、是否已有草稿在用），恢复执行时若快照发生了不该由本次调用引发的变化则直接放弃，不再覆盖已经成立的会话状态。已用真实 App 重复执行"全新启动后立即打开最近会话"验证 4/4 次成功（此前 3/3 次复现失败），并确认等待后正常打开、`swift test`（188/188）不受影响。

## [0.0.13] - 2026-08-20

### Added

- 实现 `0.0.13` 第一次 Self-build Loop 候选（ADR 0022）：`app/build.sh` 支持 `PI_DCODE_DIST_DIR` 产物目录覆盖；设置新增"自构建"页——构建候选输出到 `dist-candidate`（在用 App 全程不被触碰，输出尾部 200 行可查），候选卡校验 App / 内嵌 Host 版本一致性与签名，"重启到候选"经确认后原子替换（单备份）并自动恢复当前会话，"回滚到备份构建"同协议反向。
- 自构建重启恢复：新 App 启动时一次性消费恢复标记，Host 就绪后按打开即接管恢复原会话；替换 / 回滚失败全量回退并如实报告，无静默更新与自动回滚。

### Changed

- 将 App / Host / Info.plist / build.sh 开发版本统一提升为 `0.0.13`。

## [0.0.12] - 2026-08-20

### Added

- 实现 `0.0.12` 结构化验证证据候选（ADR 0021）：真实 bash 工具执行自动入本机证据账本 `verification-evidence-v1.json`——命令、退出推导三态（成功 / 失败(退出码) / 未知）、起止与时长、会话工作目录与当次模型；落账后异步补 `git rev-parse HEAD`（按目录缓存 5 分钟，缺席如实标注"待补"）。Agent 回复中的"已验证"文案永不入账。
- 会话检查器新增"运行证据"区：成功 / 失败 / 未知徽标、耗时、revision 短 SHA，展开查看 Run、时间、环境与完整 revision；底部声明证据是核对材料而非发布门禁。

### Changed

- 将 App / Host / Info.plist / build.sh 开发版本统一提升为 `0.0.12`。

## [0.0.11] - 2026-08-20

### Added

- 实现 `0.0.11` 只读 Exact Git Diff 候选（ADR 0020）：变更 Tab 文件行可展开，按需读取并分流呈现"已暂存 / 未暂存"两区的逐 hunk 行级差异（+ 绿 / − 红 / 上下文行、a/b 双行号、hunk 段落标题）；untracked 文件以受护栏内容作新文件预览；文件行摘要显示各区 +N/−N。
- 差异解析护栏：单文件超过 512KB 或 3000 行诚实截断（标注"仅显示前 N/M 个 hunk"并丢弃阈值后的整个 hunk）；二进制文件如实标注；读取全程 `GIT_OPTIONAL_LOCKS=0` 只读。

### Changed

- 将 App / Host / Info.plist / build.sh 开发版本统一提升为 `0.0.11`。

## [0.0.10] - 2026-08-20

### Added

- 实现 `0.0.10` 动作级权限候选（ADR 0019）：D Code Host 打开会话时注入工具调用闸门——读取放行；bash 与文件写入先查授权表，未决动作挂起并以原生权限卡询问，提供"本次允许 / 范围允许 / 拒绝"（项目外写入与自定义工具无范围键）；高风险命令（rm、`git push`、`curl|sh`、sudo 等）以高险标记呈现。
- 授权按"会话工作目录"域持久化：bash 以命令前缀（程序名 + 已知子命令，前缀后必须结尾或空白）、写入以授权根内整体生效；存储于 `~/.pi/agent/pi-dcode/permissions-v1.json`（版本化原子写），决策审计保留最近 200 条。
- 设置新增"动作权限"页：授权列表（类型 / 根 / 前缀 / 授予时间）单条撤销、最近决策记录查看；`permission.updated` 事件同步各窗口。
- 协议新增 `permission.respond` / `permission.list` / `permission.revoke` 方法、`permission.request` / `permission.updated` 事件与 `permissionGate` 能力位。

### Changed

- 将 App / Host / Info.plist / build.sh 开发版本统一提升为 `0.0.10`。

## [0.0.9] - 2026-08-20

### Added

- 实现 `0.0.9` 打开即接管候选（ADR 0018，取代 ADR 0006 默认观察立场）：所有打开路径一律可写取得租约，只读观察模式及其降级面（空上下文用量、清空命令、不可用构成占比）全部删除；过期搜索目标在关闭当前会话之前被拒。
- D Code 实例间租约支持 force 抢占：后开窗口直接接管，先开窗口一秒内以 `LEASE_STOLEN` 冲突诚实退出；静默窗口保留为防撕裂护栏（在途写入轮询到稳定，超时如实报错）。
- 冲突以 Composer 原生冲突卡呈现（区分外部写入与写入权被接管），“重新接管”一键恢复可写；草稿保留、队列暂停、Run 标记未知语义不变。
- Host 内 ModelRuntime 单例复用（修复新会话每次激活全量解析模型库的已证性能问题）；`AppStart` / `ComposerTextUpdate` os_signpost 埋点供 Instruments 实测冷启动输入卡顿。

### Changed

- 将 App / Host / Info.plist / build.sh 开发版本统一提升为 `0.0.9`；Host 协议删除只读分支与 `writeIntent` / `preserveActive` 参数及 `SESSION_READ_ONLY` / `WRITE_INTENT_REQUIRED` 错误。

## [0.0.8] - 2026-08-20

### Added

- 实现 `0.0.8` 工程内构候选：AppModel 领域状态下沉为 `SearchModel`、`ActivityModel`、`ModelSettingsState`、`FollowUpModel` 四个 `@Observable` 子模型，事件分发按会话 / 扩展 / 认证 / 宿主生命周期拆为独立扩展文件，行为零变化。
- 宿主依赖收敛为 `HostProviding` 协议并支持注入：新增 `FakeHostClient` 测试基座与 8 个无真实 Pi 依赖的状态机集成用例（握手、失败清理、进程退出、Run 状态与注意力、搜索索引、认证事件流、重启要求）。
- 新增渲染冒烟基线：RootView / ConversationView / ComposerView / ModelSettingsView 真实宿主渲染与 UserHomeView / ConversationRoundRail 结构断言；`swift test` 由 141 增至 167 用例。
- 按发布纪律在 `THIRD_PARTY_NOTICES.md` 登记测试专用依赖 ViewInspector 0.10.3（MIT，精确锁版，不进入 app bundle）。
- dgoal 结构化状态融入（ADR 0017）：Host 透传 `dgoal-work-v1` 的完整 goal（含 paused）与 `pendingProposal`；Active Plan 详情原生呈现保障档位（软性清单 / 执行 / 目标终审 / 阶段审核）、升级历史、验收标准、阶段 / 终审独立审核结果与审核模型、条目证据、暂停原因与耗时；待批提案在 Composer 交互坞获得原生批准卡，一键发送 `/dgoal review` 并由 dgoal 原生门禁对话框完成批准 / 拒绝 / 反馈。
- 上下文构成占比（ADR 0017）：Host 新增 `session.contextBreakdown` 方法与能力位，按消息种类（用户 / 助手 / 思考 / 工具结果）以 Pi 同口径估算分项、真实总量锚定并反推系统与工具；圆环弹层展示各部分占比条形与剩余可用，估算如实标注，只读会话返回不可用原因（只读态已在 `0.0.9` 随打开即接管删除）。

### Changed

- 将 App / Host / Info.plist / build.sh 开发版本统一提升为 `0.0.8`。
- Context 余量环在剩余低于 20% / 8% 时底环转橙 / 红；旁侧常显本轮运行累计的上下文增减（+ 新增 / − 释放分列）。

## [0.0.7] - 2026-08-20

### Added

- 实现 `0.0.7` Model Settings（模型设置）候选：Settings 主目录只按已认证 Provider 展示 Pi 模型、缓存 / 显式刷新、全局 `enabledModels` 精确与通配规则以及全局默认模型；未认证 Provider 收拢到页面底部的关联入口，并通过 Pi 原生 API Key / OAuth 登录合同关联，项目级覆盖保持只读，自定义 Provider 编辑不进入本版。
- 最终助手回复下方常驻显示完成或失败、完成时间、耗时与本轮 Pi Assistant Message 已持久化 `usage.totalTokens` 合计；工具过程失败后成功恢复不会误标整轮失败，缺失或异常数据不估算，费用金额与跨会话统计仍留在独立版本。
- 运行中的 Composer 新增“立即介入 / 排队等待”选择：立即介入使用 Pi steer 在下一安全模型边界进入当前 Run，排队等待继续使用 D Code 可编辑、可重排、可恢复的耐久 Follow-up Queue；介入失败或运行异常时恢复原正文。

### Changed

- Context 圆环改为完整蓝环表示剩余容量、白色覆盖表示已用比例；左侧轮次导航从顶部紧密累积，轮次跳转不再给整轮绘制蓝色选中框。
- 模型启用不再提供手写规则输入框或“恢复全部”捷径，普通路径统一为模型行上的“加入全局启用 / 移出全局启用”，既有通配规则继续只读说明来源。
- Pi Thinking 在运行中跨 Assistant / Tool 边界保留，并可与当前工具、流式正文同时查看；实时展示有 `100,000` UTF-16 code unit 上限并在截断时明确标记，完整持久化内容仍随会话读取；完成后展开一次“中间过程”即可直接阅读思考正文。

### Fixed

- 超出 Swift 整数范围的异常 Pi 数字字段现在按未知数据忽略，不再因历史回复中的畸形 token 用量触发 App 崩溃。
- Return 在 Composer 聚焦时直接按当前发送方式提交，不再落到轮次导航；稳定完成和普通中止不再显示没有后续行动价值的 Interaction Dock 卡片。

## [0.0.6] - 2026-08-16

### Added

- 实现 Session Sidebar（会话栏）的 Activity View（活动视图）：搜索旁铃铛只切换左侧投影，默认置顶 / Recent / Project 导航与唯一 Conversation 主页面保持不变；活动列表固定优先显示等待处理、当前真实运行和新完成结果，其余可见 Session 按可靠活动时间分组排序。
- Host 新增 `sessionRunState` 能力与 `session.runStateChanged` 事件，以稳定 Session / Run 身份区分运行、结构化等待、停止请求、正常完成、失败、中止与未知结果；正常完成只有在最终助手 Entry 经既有 Lease 同步后才公开稳定 completion identity。
- 新增版本化、原子且有界的本机 Activity Attention Store（活动关注记录）：蓝点只表示最新稳定完成结果尚未在对应 Conversation 实际可见，不保存消息正文、Thinking、工具结果或凭据；同一 Session 的后续完成可以重新产生蓝点。

### Changed

- 将 App / Host 开发版本提升为 `0.0.6`，并把当前 Run、结构化等待、停止 / 安全重试门禁与 `0.0.5` Follow-up Queue 收敛到 Composer 附近的 Interaction Dock（交互坞）；未知结果会阻止自动继续和重复发送。
- Activity View 与默认导航复用相同的 D Code Recent / Project / Archive 可见性资格；置顶不改变活动排序，运行期间选择其他 Session 会明确说明必须先完成或停止，不会伪装成后台多会话执行。
- Composer 将 Context（上下文）改为模型名称左侧的剩余量圆环：圆环只表达剩余比例，悬停或展开后再显示已用量与总容量；模型、推理强度和速度仍由相邻的统一运行设置菜单管理。
- 将完整 Model Settings（模型设置）从 `0.0.13` 前移到 `0.0.7`；Project Trust、Exact Git Diff、结构化验证、自构建与本机资源版本依次顺延，自定义供应商仍保持在 `0.0.14`。

### Fixed

- 修复会话前草稿清空当前 Session 模型状态后又无法在真实 Pi Session 创建前读取模型，以及模型选择器把已登记 / 已认证模型误当作已启用模型的问题：新会话现在从当前 `cwd` 生效的 Pi 配置读取 `enabledModels` 精确或通配范围、对应本机可用模型与范围内的精确默认项，在统一运行设置菜单中标出“Pi 默认”并可一键恢复；未启用的 Provider / Model 不再进入选择器。没有默认项时要求用户显式选择，模型未加载或未选定时禁止发送，选定模型会在第一条 Prompt 前通过 Host 应用。该修复不保存凭据、不修改 Pi 默认，也不提前引入完整模型设置管理。
- 修复新会话把未读取到的 Fast Mode 状态显示为不可关闭的“极速”的误导：独立极速按钮已移除，模型、推理强度与速度合并为一处运行设置；草稿默认“标准”，仅 Host 明确标记支持的 `openai-codex` 模型可选择“极速”，显式选择会在模型与推理强度之后、第一条 Prompt 之前应用；既有会话即使切到不支持的模型也始终可以恢复“标准”。
- 铃铛切换在 VoiceOver 中同时说明当前是“会话导航”还是“活动视图”以及是否有新完成结果；Activity 选中态不再只依赖蓝色图标表达。
- 修复 `agent_end` 已结束流式展示但 Host 尚未确认 Run 终态时，直接发送、切换 Session 或队列提前派发可能被短暂放行的问题；运行与队列结算现在只接受匹配 `runId` 的 Host Run State 证据。
- 结构化等待现在区分选择、确认、输入与编辑；同时存在多个原生请求时，关闭其中一个不会误报恢复运行，Interaction Dock 的停止 / 安全重试按钮也保持为独立无障碍操作。
- 修复重启后 Project 尚未展开时持久化新完成蓝点可能不显示，以及最终 Assistant 后追加安全元数据条目会令稳定完成身份误降为 unknown 的问题；相关 App 测试存储同时改为完全隔离，不读取真实用户关注文件。
- 修复会话栏与信息检查器共享分隔线只能通过无障碍增减、鼠标却无法拖动且命中范围过窄的问题：透明 SwiftUI 手势面已改为 macOS 原生 AppKit 指针跟踪，隐形命中区扩大至 20pt，同时保留细视觉边界、左右调整光标、双击恢复默认、宽度持久化与 VoiceOver 可调节语义；会话栏默认宽度仍为 400pt，但最小宽度由 400pt 调整为 280pt，不再把默认值误当成最小值。

## [0.0.5] - 2026-08-16

### Added

- 冻结 `0.0.5` Follow-up Queue（后续消息队列）的产品范围与所有权决策：尚未派发的 Queue Item 由 D Code 以本机耐久状态管理，绑定当前 Session / Path；只有经 Host 交给 Pi 并取得匹配的持久化证据后才成为会话消息。
- 实现 Composer 附近的原生 Follow-up Queue：运行中可继续输入普通文本，待派发项可查看、编辑、上下移动与撤回；队列以本机原子 Store 跨重启保留，派发与 Run 结果不明时停住并要求核对。
- Host 公开 `sessionRunCorrelation` 能力门禁，App 只在能将 `session.event.runId` 与 Prompt 稳定关联的 `0.0.5` Host 上启用后续消息队列。
- 确认 `0.0.6` Activity View（活动视图）与 Run State（运行状态）的下一版范围：会话栏铃铛切换活动投影，可靠运行与等待优先，新完成结果以可恢复蓝点提示，其余会话按活动时间排序；本版仍不声称后台多会话执行。

### Changed

- 将 App / Host 版本定版为 `0.0.5`；Conversation 继续是无冗余标签的唯一会话主页面，本版只增加 Composer 附近的最小队列表面，完整 Run State / Interaction Dock 留到 `0.0.6`。
- “新建会话”改为先进入本地会话前草稿：空白草稿离开即消失，不再创建或遗留 Pi 空会话；非空正文由原子草稿资料恢复，只有首次发送时才调用 `session.create`，创建后打开或发送失败则把正文保留到该真实 Session 草稿中并明确提示。

### Fixed

- Composer 获得输入焦点时不再给整个输入容器绘制持续蓝色选中框；文本插入点与键盘输入继续可用，点击其他工作区后也不会遗留误导性的整框选中效果。
- Session Sidebar（会话栏）与 Information Inspector（信息检查器）统一为默认及最小 `400 pt`、最大 `520 pt`；旧的窄会话栏保存值在布局时自动校准，Project 名称、创建与展开操作不再被压缩在明显偏窄的左栏中。

## [0.0.4] - 2026-08-15

### Added

- 主工作区新增按需出现的本机文件只读标签；对话继续作为唯一主页面且不显示冗余标签，关闭最后一个文件后直接返回主页面。Project 文件树和助手 Markdown 中的本机文件 / 行引用复用同一安全入口，重复路径只聚焦已有标签，切换期间保留现有会话视图与逐字草稿。
- 文件预览只读取已登记 Source Folder 内的普通 UTF-8 文本，并有界拒绝越界路径、符号链接、目录、二进制、超限与读取竞态；来源授权移除后仅保留已加载的内存快照，不继续刷新磁盘。

### Changed

- `0.1.0` 前路线改为按自迭代闭环逐层生长：`0.0.5` 后续消息队列、`0.0.6` 运行状态与 Interaction Dock、`0.0.7` 项目信任与动作权限、`0.0.8` 精确 Git 差异、`0.0.9` 结构化验证证据、`0.0.10` 首次自构建 / 重启 / 恢复、`0.0.11` 一次性资源调用、`0.0.12` 本机资源管理、`0.0.13–0.0.14` Pi 模型设置与自定义供应商、`0.0.15–0.0.16` Markdown / HTML 工作流、`0.0.17` 失败恢复加固；之后允许继续增加真实 dogfood 缺口版本，不再把 `0.0.9` 当作硬终点。Goal / Work Map、D Team 与跨 Session 编排移至 `0.1.0` 之后的候选方向。
- 已置顶会话改为会话栏最上方的全局独立区域，并从 Recent / Project 普通列表去重；普通会话行只常驻显示单行标题，悬停或键盘聚焦后再展示完整标题、更新时间、Project、Source Folder、完整 `cwd` 与当前 Git 分支。会话行同时新增稳定且保留内部留白的中性 Hover / 选中反馈；Window control band、会话栏身份行、“新建项目”、Project 与 Session 导航行统一为 `36pt`，纯图标动作仍使用 `13pt` glyph、`18pt` glyph box、`28pt` 状态表面和 `32pt` 目标，尾部 action rail 固定为 `64 × 32pt`，不再依赖页面级图标偏移或大透明 frame。
- 设置不再打开第二个 macOS 窗口：左下角齿轮与 `Command-,` 都在当前窗口进入完整 Settings 工作台页面。该页面临时让出日常会话栏与信息检查器，以页内设置导航组织“外观 / 工作台 / 已归档会话 / 关于 D Code”，右侧使用受限宽度的分组内容；返回工作台后恢复原栏位偏好。已归档会话沿用同一页面外壳，不再叠加 Sheet，也不再占用普通会话列表空间；关于页显示 App 图标、版本 / 构建号、作者 GitHub 与项目 GitHub。会话栏底部在 Host 健康可用时不常驻显示“运行服务已就绪”，只在连接中、未连接或失败时显示可解释状态。
- Pi 结构化图片内容块不再只显示占位文案：消息内显示紧凑方形缩略图，点击后可在原生查看器中查看和缩放原图；图片只从 Pi Session JSONL 做有界内存解码，不复制为第二份本机附件，也不会自动加载任意远程 Markdown 图片。
- 对话导航尺统一使用中性刻度；已经恢复的工具或命令失败不再把整个工作轮标成橙色，真实失败仍由轮次摘要与可展开过程明确说明。
- 完成工作轮的耗时与持久化完成日期改为最终助手回复外部的 Hover / 键盘聚焦元信息；默认阅读面只保留最终回答与必要的中间过程摘要，工具数继续留在可展开摘要中。
- 助手 Markdown 改用原生块级标题、段落、列表、引用、分隔线与表格呈现；粗体结尾紧接中文时仍按用户标记渲染，复制继续返回未经展示归一化的原始正文。
- 单 Source Folder Project 的 Files 改为直接平铺根目录内容；Project 内新建会话在零个 Source Folder 时禁用并引导添加、一个时直接创建、多个时才弹出选择。打开 Project 所属 Session 后，信息检查器继续保留 Files / Changes 并叠加会话概览。顶部栏、主工作区和右侧信息检查器 rail 统一 canvas 底色，会话栏保留下层色阶并从标题栏左段连续延伸到底部；主画布圆角不再向左栏投射外阴影，信息检查器与 Composer 以共享 raised surface 表达层级，不再依赖贯穿窗口的硬分隔线。
- 窗口顶部收口为与 macOS 红黄绿按钮同排、共享中心线的 `36pt` 单一控制带：会话栏开关、真实会话名称与菜单、信息检查器开关按所属列排列，不再叠加独立按钮栏；会话栏不可见时，左上控制带补充“新建会话”入口。空白控制带双击遵循 macOS 的“连按窗口标题栏”偏好，执行放大 / 还原、最小化或无动作，不被自定义拖拽吞掉。会话操作支持持久重命名、恢复自动名称、置顶、归档、谱系和复制；没有工作对象时不重复产品名。两侧开关与新建会话默认只显示小图标，Hover / pressed 才出现 `28pt` 圆角方形状态面，不再由 macOS Toolbar 强制包成孤立玻璃胶囊。文件标签带只在打开文件后出现并直接沿用主画布底色，不再形成第四层横向 surface。信息检查器首行直接列出当前可用的“会话 / 文件 / 变更”视图。
- 会话栏与信息检查器支持拖动、双击恢复和 VoiceOver 调整宽度，并跨重启保留；拖动会保留主工作区的最小宽度，不在操作过程中把另一栏挤走。信息检查器的默认及最小宽度提高到 `400pt`，旧窄值自动校准，完整 Session ID 保持单行；空会话提示改为在标题区与 Composer 之间的正文区域真正居中。
- Composer 上方新增会话工作摘要：当前 Session Path 显示 Plan 步骤，整个稳定 Session ID 聚合 DHashline-compatible `edit` / `write` 的已确认文件数与增删行活动；展开后可查看规范路径和首个变更行。账本只保存有界元数据，不保存源码或完整 patch，并明确标注覆盖可能不完整、不是 Git 净差异。

## [0.0.3] - 2026-08-13

### Added

- `0.0.3` 会话路径：原生查看当前与历史 Session Path，从用户消息“编辑并重走”或从助手消息继续；路径切换只更新会话上下文，不改项目文件、Git 或工作树。
- 逐 Session / Path 本机草稿：切换会话、路径和重启后逐字恢复；待创建路径只有第一条非空用户消息真正持久化后才成为 Pi 路径。
- Session 菜单提供“复制到项目…”与“复制到项目并归档原会话…”；目标使用新 Session ID 和目标 Source Folder `cwd`，保留完整持久化历史与源谱系，源 Pi JSONL 不变。
- 左栏新增“已归档会话”：归档仅排除 D Code 的 Recent、Project 与 Search，可查看来源、复制目标和归档时间并恢复显示；复制成功但归档失败时保留可重试状态。
- Recent 与 Project 会话行新增 Hover / 键盘聚焦置顶和直接归档操作，并在右键与会话菜单提供等价入口；置顶跨重启、在分页前排序且不扩大可见范围，直接归档保留 Pi JSONL、逐路径草稿与置顶状态。
- 会话正文按用户消息组织为工作轮：完成后默认只显示最终回答及耗时、工具数和完成时间，中间 Thinking、过程回复与工具记录按轮折叠；运行中只显示当前思考或当前工具。
- 长会话左缘新增对话导航尺：悬停刻度预览用户问题与最终回答，点击或键盘调整只滚动定位当前 Session Path 内的工作轮；定位历史后暂停自动追尾，可显式“回到最新”。
- `pi-dhashline` 的 read/edit/write/search 由既有 Host 扩展执行路径继续提供，D Code 新增原生锚点、边界行和 diff presenter；write/edit 正文默认隐藏，不调用扩展的 `pi-tui` renderer。
- 空的 D Code 创建会话可从 Recent 右键菜单或会话操作菜单移到 macOS 废纸篓；非空、旧 Pi、可写或有子会话引用时保留原文件并引导归档。

### Changed

- Host 兼容门禁提升到 `0.0.3` 并要求 `sessionPaths`、`sessionCopy`、`sessionVisibilityExclusions`；归档 ID 在列表分页和搜索排序/截断之前排除。
- 完整会话复制改用隐藏暂存中的有界流式校验与同卷原子发布；严格拒绝损坏 JSONL、重复 Entry ID、缺失父节点、半条尾记录、源变化和 Busy 状态，失败目标不会进入正常导航。
- Project 展开加载因收起项目或侧栏生命周期结束而被取消时静默保留已有缓存，不再把正常的 `CancellationError` 显示为“无法读取项目会话”。
- 新建 Session 在完整 Header 与 D Code 来源落盘后立即返回并显示于 Recent；旧可写 Runtime 最长十余秒的安全清理改为随后独立打开阶段，不再阻塞创建反馈。
- Work Inspector 在 `≥880 pt` 时优先作为非模态右栏常驻，不再压暗或禁用左栏与会话；`880–1105 pt` 由左栏改用临时覆盖保留中央宽度，紧凑窗口继续使用互斥面板。
- 助手 Markdown 改为保留段落、空行、无序与有序列表换行，同时继续解析行内粗体、链接和代码；复制仍使用原始消息正文。
- Project 新建、Session 操作与模型选择菜单只保留各自一个下拉指示；会话标题栏与侧栏置顶 / 归档图标对齐标题行，同时保留 `40 pt` 命中区和原生菜单无障碍语义。
- 后续版本路线校准为 `0.0.6` Goal / Work Map（耐久工作对象与人工门禁）→ `0.0.7` 当前 Session 内的 D Team 执行层 → `0.0.8` 以 Work Item 为锚点的持久跨会话交接 → `0.0.9` 本机 Skill、权限策略、有效授予、审计与恢复收口；Todos、MiniMax Code 与 `pi-dteam` 只作为本地 UI / UX、工作地图和执行机制参考，不改变 `0.0.4–0.0.5` 切割，也不表示这些能力已由当前 App 实现。

## [0.0.2] - 2026-08-12

### Added

- `0.0.2` 可见会话搜索：通过左栏入口或 `Command-K` 打开原生浮层，搜索 D Code Recent 与已关联 Project 的会话标题、当前活动路径用户正文和助手正文；支持 Project / Source Folder 筛选、稳定 Session ID 打开、Entry ID 定位和短暂高亮。
- 全局“新建会话”直接使用当前 macOS 用户目录作为 `cwd`，不再弹出文件夹选择器；Project 内新建仍从已登记 Source Folder 中选择。
- Host 使用固定 Node 运行时内置的 SQLite FTS5 与独立 Worker 建立可删除、可重建的本机索引；中文使用单字与重叠双字词，相邻短语按连续位置匹配，结果片段指向真实命中；查询时再次强制可见范围，不索引 thinking、工具载荷、工具结果、认证字段或非当前会话路径。
- 搜索浮层显示期间每秒执行一次轻量文件身份探测：只遍历 JSONL 路径并读取已判定可见候选的文件元数据；非当前会话被外部新增、更新或删除后自动使缓存失效，检测到漂移后才进入完整索引刷新。

### Changed

- App/Host 兼容门禁提升到 `0.0.2` 并要求 `sessionSearch` 能力；搜索和索引不会取得 Session Lease 或修改 Pi JSONL，正在追加的半条目会保持索引未完成并按指纹退避重试，刷新期间的新失效信号不会丢失。运行期 SQLite 缓存损坏只进行一次安全重建；持续失败会锁存为可操作错误，等待显式重试，不形成重建循环。

## [0.0.1] - 2026-08-11

### Added

- `0.0.1` 原生工作台：冷启动 User Home、由 D Code 新建的最近会话每次 10 条递增加载、D Code Project 与多 Source Folder、关联文件夹后发现旧 Pi 会话、项目内跨文件夹平铺会话、响应式三栏、按需只读文件树及真实只读 Git Changes。
- macOS 原生 Settings 窗口与左栏齿轮入口，用于持久化系统/浅色/深色外观、左栏和宽屏工作检查器偏好，并可恢复默认布局。
- Project 元数据使用本机版本化 JSON 原子保存；规范化目录全局唯一，跨项目移动需要再次确认，损坏或不支持的资料会保留原文件并禁用后续写入。
- Composer 集中真实模型、思考强度、Context Usage 与 D Code 自有极速状态；极速按 Session 持久化，只在支持的 `openai-codex` 模型请求 `service_tier: priority`。
- Protocol v1 增加 `session.list.cwdScope`、`session.list.origin`、`session.refresh`、`session.setFastMode`、Context Usage/Fast state；`session.create` 在初始 JSONL 中写入不进入模型上下文的 D Code 来源标记，Recent 在分页前据此筛选。初始文档发布后即确认创建，后续可写激活失败会返回已创建对象并降级为观察或明确不可用，不产生重启后才出现的幽灵会话。App 会在读取会话前校验 Host 版本与 0.0.1 必需能力。

- Node/Pi Host Protocol v1、Session Lease、持续会话观察与按需写入、失效租约自动恢复、结构化 Extension UI Bridge、父进程消失后的有界退出与原生 Unicode Mermaid 渲染动作。
- macOS 14+ SwiftUI/AppKit 原生工作区侧栏、Recent 与 Project 会话导航、显式“新会话/重新载入”动作、历史/工具/Thinking 展示、会话创建与打开入口、流式 Composer、活动 Plan 浮层、代码/Mermaid 内容块和原生扩展对话框。
- Swift Host 子进程桥、连续 JSONL 请求关联、streaming/persisted 回复去重、Finder 环境补全、诊断脱敏与真实会话观察冒烟；Mermaid 支持缩放、复制源码/图片、PNG 导出及不支持类型的显式源码回退。
- 本机 arm64 `D Code.app` 装配脚本：内嵌 Node 22、Host 与生产依赖，使用本地 ad-hoc 签名，无需手动启动辅助服务。
- `D Code.app` 增加首枚临时品牌图标：以层叠 `D` 形工作台为主体，使用石墨外层与琥珀色工作内层，并随本机 App 构建写入 `.icns` 资源。
- 既有会话可在 App 内持续观察，发送或修改运行设置时以本次操作表达写入意图；Host 通过静默窗口、原子租约和外部写入检测保护单写入，不要求 CLI 插件或 Handoff ID。D Code 创建来源标记只控制 Recent 导航可见性，不充当写入锁或接管凭据。
- 增加 D Code 专有源码可见声明、第三方许可证索引与构建期许可证清单；本机 App Bundle 随包保留 Node.js、Pi、Apache-2.0 及缺失 npm 包的许可与归属信息。

### Changed

- Composer 的占位文字与光标改由同一原生多行文本控件排版；删除通用“能力状态”常驻菜单。Pi RPC 的工具展开查询恢复中性 `false` / no-op（空操作），被忽略的展示提示不再上浮全局警告。
- 既有 Pi 会话不再显示默认“只读/继续”界面：D Code 以正常 Composer 持续观察当前 JSONL，文件身份变化后从已知路径刷新；发送或修改运行设置时按需取得租约。外部同时写入会中止 D Code 写入、释放所有权、保留草稿并返回持续观察。
- D Code 删除对 `@earendil-works/pi-tui` 的直接依赖、Host headless TUI 渲染、Protocol custom input/resize，以及 Swift 兼容面板和 widget 呈现；标准结构化扩展对话框与状态仍保留，custom/widget 等 TUI 请求改为显式阻止或忽略。`pi-coding-agent` 私有传递依赖中的 `pi-tui` 保留但不由 D Code 调用。
- `extension.respond` 在进程入口绕过普通请求队列，结构化扩展对话不会再与等待响应的 `session.prompt` 互相阻塞；会话关闭或 Host 结束时同时清理原生扩展界面状态。
- 建立 `doc/参考文件/`，记录 Codex、ZCode、MiniMax Code、PiDeck、Flue、Orca、pi-intercom 与 pi-messenger 的借鉴点和不采用边界。
- 产品交互契约与原型统一为“点击 Project 直接查看全部 Source Folder 文件树、项目下跨文件夹平铺 Pi Session、来源文件夹作为会话副标题”；版本演进相应调整为 `0.0.1` 建立项目文件范围、`0.0.4` 提供中央标签与普通文件只读查看、`0.0.5` 提供 Markdown/HTML 未保存缓冲区即时预览。此项只记录目标与原型，不表示原生 App 已实现。
- 产品交互契约与原型将模型与思考强度、极速开关、上下文占用集中到 Composer 底部；Work Inspector 的 Context 只呈现当前路径与已加载来源，顶部运行状态不再重复这些输入状态。此项只记录目标与原型，不表示原生 App 已实现。
- 用户可见产品名、应用包与界面文案统一为 `D Code`，其中 `D` 取自创作者长期使用的网名 `diwu`；项目目录使用 `dcode`，内部 Swift 目标、Host 包名、环境变量、Bundle ID 与租约目录保留既有兼容标识。
- 有界 `session.list` 在解析摘要前先按文件 mtime 选择最近候选；现实 1233 个会话、约 2.4 GiB 下，最近 60 项列表降至亚秒级。
