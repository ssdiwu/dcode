# D Code 原生界面设计系统

> Status: Current Implementation Authority（当前实现权威）
> Scope: macOS 14+ SwiftUI / AppKit 的视觉层级、组件几何、交互状态、无障碍与人工验收。未来产品能力仍由 `20-产品与交互/` 和对应版本 PRD 定义。

## 1. 权威边界

本文件规定“当前 D Code 原生界面应该呈现成什么样、共享组件必须满足什么结果”。

- 本文件拥有语义规则、状态优先级和可观察结果。
- [`DesignSystem.swift`](../../app/Sources/PiDCode/Views/DesignSystem.swift) 拥有当前可执行 token（令牌）和共享 primitive（基础组件）。
- Feature View（功能视图）只能组合这些规则；局部源码不是第二套设计规范。
- `20-产品与交互/` 规定跨版本目标，`40-版本实施方案/` 规定版本切片；尚未实现的目标不得写成当前组件事实。
- HTML 原型和竞品截图只能验证信息层级或交互方向，不能覆盖原生组件与产品语义。

借鉴 Curio 的是“规范定义语义、共享代码持有数值、容器驱动几何”的方法。D Code 不复制 Curio 的品牌色、圆体、Liquid Glass（液态玻璃）、iOS 44pt 触控尺寸或页面外观。

## 2. 设计性格

D Code 的界面性格是 **Calm, precise, capable（克制、准确、可靠）**。

- 工作对象和当前状态先于装饰。
- 中央会话保持可阅读；技术过程、工具输出和诊断信息渐进披露。
- 用系统语义色和真实原生控件表达状态，不制造伪终端或网页仪表盘。
- 只在事实成立时显示成功；活动、限制、错误和 destructive（破坏性）动作不得共用一个模糊颜色。
- 密度服务于工程历史阅读，但不能以贴边、重叠或难以命中换取紧凑。

## 3. Foundations（基础）

### 3.1 网格与间距

以 `4pt` 为基础网格。当前共享间距为：

| Token | 值 | 角色 |
|---|---:|---|
| `gridUnit` / `spacingTight` | `4pt` | 同一语义单元内部 |
| `spacingStandard` | `8pt` | 控件与文字、容器内边距 |
| `spacingGroup` | `12pt` | 同一组件中的相邻分组 |
| `spacingSection` | `16pt` | 独立语义区之间 |

`24pt` 与 `28pt` 仅用于阅读画布等大范围 breathing room（呼吸空间），不应成为紧凑控件的默认 padding（内边距）。新数值只有在重复形成稳定角色后才进入共享 token；否则由单一组件局部拥有，并说明几何原因。

禁止：

- 用负 padding、逐 glyph `offset`、透明占位或命中区重叠修复几何；
- 同一角色在不同页面拥有不同间距；
- Hover 出现动作后改变标题宽度、行高或相邻行位置。

### 3.2 圆角

| Token | 值 | 角色 |
|---|---:|---|
| `compactRadius` | `8pt` | 紧凑导航行、轻量状态表面 |
| `controlRadius` | `10pt` | 输入控件、工具与操作表面 |
| `messageRadius` | `14pt` | 用户消息气泡 |

同一可交互对象只能拥有一个主要表面。不要在行、按钮和卡片之间堆叠多层圆角背景。

### 3.3 颜色

- 使用 macOS semantic colors（语义色）：`windowBackgroundColor`、`textBackgroundColor`、`controlBackgroundColor`、`primary`、`secondary`、`accentColor`。
- 绿色只表示 verified ready / writable / completed（已验证就绪、可写、完成）。
- 橙色只表示仍在进行或明确受限的状态；已经恢复的历史过程不染色整个工作轮。
- 红色用于真实错误、停止和 destructive 操作。
- Hover 与 selected（选中）优先使用中性层级；不能只靠颜色区分选中、失败或可操作性。

### 3.4 排版

- 消息正文和导航主标题使用系统 body（正文）层级。
- Primary label（主标签）使用 semibold body / headline，不使用营销式大标题。
- Secondary metadata（次级元信息）使用 caption；时间和计数使用 monospaced digits（等宽数字）。
- Hint（提示档）是独立于次级元信息的更低一档：输入框占位符与空态提示使用 `tertiaryLabelColor` / SwiftUI `.tertiary`（约 `0.26` 不透明度），字号与所在输入正文一致。不得使用 `secondary`（约 `0.5`）——那是元信息档，空输入框会因此读成"已经有内容"。同样不能用 AppKit 的 `placeholderTextColor`：它在 macOS 上与 `secondaryLabelColor` 同为 `0.5`，名字像提示档但权重不是。提示与真实正文必须共用同一套布局几何（同一 text container 原点或同一行高推导），不用手工偏移常数对齐。
- 路径、Session ID、JSON、命令与代码使用 monospaced（等宽）字体。
- 长路径中间截断，并通过 help、选择或详情暴露完整值。
- 设置 > 外观提供“界面字号”档位（紧凑 / 标准 / 大，`DCodeInterfaceFontScale`）：标准档完全跟随系统 Dynamic Type；紧凑 / 大档在系统当前值上整体下移 / 上移一级，并封顶在常规层级（无障碍特大档不参与，避免破坏三栏与行高几何）。全部语义字号经同一机制缩放，不逐处改字号、不引入逐视图自定义字号。

### 3.5 Surface 与 elevation

- 主工作区会话是 reading canvas（阅读画布），使用 `windowBackgroundColor`；window control band（窗口控制带）、主工作区 canvas 与右侧 Inspector rail 必须延续同一 canvas，不得形成独立顶栏色块或右侧底色。会话栏是较低一层的导航 surface，在同一系统底色上叠加极低强度中性色阶。
- 会话栏的导航 surface 从窗口顶部延续到底部，标题栏左段与下方栏体必须是同一像素底色；主工作区 canvas 覆盖在它上方，以统一的左侧圆角轮廓形成“导航承托工作内容”的嵌套关系，但不得向会话栏投射外阴影或材质渐变。Window control band 与其下内容是同一块主工作区 canvas，不得分别铺背景、出现横向接缝或形成上下两层标题区。
- 信息检查器与 Composer 是 raised surface（抬升表面）：共享连续圆角、语义背景、低强度描边与柔和阴影。阴影表达层级，不表达选中、成功或错误。
- 外层栏位不得再用贯穿窗口的硬 Divider 作为主要边界。必要 hairline 只用于单个 surface 内部、无法由间距和分组表达的语义切割。
- window control band 与 canvas、canvas 与 Inspector rail 之间不设可感知的水平或整高垂直分割线；区域关系由会话栏色阶与 raised surface 的阴影、描边表达。
- raised surface 的 shadow 不得扩大 hit target、遮断相邻控件或改变 Accessibility（无障碍）顺序；Reduce Transparency / Increase Contrast 下仍由语义背景与描边保持边界。

## 4. 几何系统

### 4.1 图标动作的四层盒

每个纯图标动作由四个互不混淆的层组成：

1. **glyph**：SF Symbol（系统符号）的可见图形，当前标准为 `13pt medium`；
2. **glyph box**：所有同组 glyph 共用的 `18 × 18pt` 固定视觉槽位；
3. **visual surface**：Hover / pressed 时出现的紧凑圆角方形表面，当前标准为 `28 × 28pt`；
4. **allocation / hit target**：macOS 紧凑图标动作统一占用 `32 × 32pt`，放在统一的 `36pt` 导航行中；不以更大的透明 frame 撑高顶栏或会话行。

SF Symbols 的自然宽高和 optical metrics（视觉度量）不同；规范要求共同槽位和共同中心线，不要求不同轮廓拥有相同顶边或底边。业务页面不得按 symbol 单独补偿 `x/y offset`。若一组 symbol 在共同槽位中仍无法形成可接受的视觉家族，应更换整组 symbol，而不是移动其中一个。

`IconActionGlyph` 负责 glyph 与 glyph box，`IconActionStyle` 负责 visual surface、hit target 与 pressed（按下）反馈。两者不能在调用页面被重复包 frame 或位移。默认状态只显示 glyph；Hover / pressed 才显示圆角方形 surface，不常驻玻璃圆形、胶囊、描边或第一焦点环。

### 4.2 多动作行

一个同时包含选择和尾部动作的 row（行）必须是稳定容器：

- 主内容是独立 selection Button；尾部动作是同级 sibling Buttons（兄弟按钮），不得嵌套；
- 容器使用共同垂直中心线；尾部 action rail（动作轨道）固定占位；
- action rail 的按钮 frame、glyph box、间距和中心 `y` 完全一致；
- Hover / focus 只切换透明度、hit-testing 和反馈，不改变任何 frame；
- 每个动作的命中区互不重叠，并拥有对象化 accessibility label（无障碍名称）。

### 4.3 Modifier（修饰器）顺序

组件通常按以下顺序建立：内容 → 视觉 glyph box → 组件 frame → contentShape → 背景 / 描边 → 状态动画 → accessibility。

把 `offset` 放在 frame 之后只会移动绘制内容而不参与布局；把透明 padding 当命中区则容易与相邻按钮重叠。这两类写法都不允许作为生产修复。

## 5. 状态矩阵

| 状态 | 行级反馈 | 动作反馈 | 几何 |
|---|---|---|---|
| Rest（静止） | 透明或页面基础面 | 非持久动作可隐藏 | 不变 |
| Hover（悬停） | 低强度中性填充 | 显示可用动作 | 不变 |
| Selected（选中） | 持久、较强的中性填充与 `.isSelected` | 持久状态动作可常显 | 不变 |
| Keyboard focus（键盘焦点） | 独立 accent focus ring（强调焦点环） | 当前按钮可见且可操作 | 不变 |
| Pressed（按下） | 不改变行布局 | 当前按钮获得短暂表面 / scale 反馈 | 不变 |
| Disabled（禁用） | 保留对象上下文 | 降低强调且不可触发 | 不变 |

优先级：Keyboard focus > Selected > Hover > Rest。Pressed 只属于正在操作的按钮；Disabled 不得抹去 Selected 或错误等必要上下文。状态不能依赖动画或颜色单独成立。

## 6. 当前布局

工作台只使用三种栏位术语：左侧称 Session Sidebar（会话栏），中央称 Main Workspace（主工作区），右侧称 Information Inspector（信息检查器）。Settings（设置）、Archived Sessions（已归档会话）等“页面”只能在主工作区内切换；会话栏负责导航，信息检查器负责补充事实，二者都不是页面容器。源码中的 `WorkInspector` 仍是既有内部类型名，不作为用户文案。

- 默认窗口 `1360 × 860pt`，最小 `640 × 620pt`。
- 会话栏与信息检查器默认均为 `400pt`，可在 `400–520pt` 内调整；左栏为 Project 名称、行内动作与后续 Activity View 保留稳定宽度，右栏保证完整 Session ID 在标准字号下保持单行。旧于该下限的已保存栏宽在布局时自动校准。宽度本机保存，拖动内侧边缘、双击恢复默认。该边缘只是透明命中区：常态、Hover（悬停）、拖动与键盘聚焦都不显示竖线、胶囊或系统蓝色焦点框，只通过水平调宽光标表达可拖动性。
- 每个逻辑栏位只有一份 Shared Rail Geometry（共享栏位几何）。Settings 的页内设置导航在语义上不是会话栏，但继承会话栏当前实际宽度和同一调整入口；在 Workspace 或 Settings 中改宽都会立即影响另一页面。信息检查器同样在所有 Project、Session 与后续页面间共享一份实际宽度。页面不得硬编码私有宽度或复制偏好状态。
- 三栏并排时始终为主工作区保留至少 `480pt`；拖动达到当前窗口可用上限后停止，不把另一栏挤走。当窗口本身不足以容纳当前保存宽度时，会话栏按中宽规则改为临时覆盖。
- `≥880pt` 信息检查器保持 inline / non-modal（内联、非模态）；当会话栏、主工作区最小宽度与信息检查器的当前宽度可同时容纳时三栏并排，否则会话栏临时覆盖；`<880pt` 会话栏与信息检查器互斥覆盖。
- Conversation（会话）阅读区最大 `820pt`，横向 `28pt`、纵向 `24pt` breathing room。
- 主页（无会话打开的主工作区）是落地即可打字的会话前草稿：居中 Composer（最大约 `640pt`）+ 作用域托盘，输入框保持画布几何中心——最近会话行挂在下方、不参与居中计算（按其实测高度做顶部补偿），有无可最近会话输入框位置不漂移；下方保留 2–3 条最近会话安静行（标题 + 右对齐相对时间，点击即继续），无最近会话时不占位。点击会话到内容呈现之间主画布立即显示加载态（spinner + “正在打开会话…”），会话行同步进入选中态，不出现无反馈空白期。
- Conversation rail（会话导航尺）只有中央会话宽度至少 `640pt` 且存在至少两个工作轮时才出现；视觉轨道约 `44pt`，不遮挡正文或添加蒙版。
- Window control band（窗口控制带）是唯一的顶部 identity / action plane（身份 / 动作平面），与会话栏导航统一使用 `36pt` 行高：红黄绿窗口按钮、会话栏开关、主工作区对象名称与菜单、信息检查器开关共享同一条水平中心线。会话栏不可见时，“新建会话”紧跟会话栏开关出现在左上控制带；会话栏恢复后该入口退出，避免与栏内动作重复。顶栏图标动作仍只占用 `28 × 28pt` 视觉表面和 `32 × 32pt` 目标，默认只显示 glyph，Hover / pressed 才出现圆角方形 surface。不得再在其下新建独立的区域按钮栏或跨三列的第四个 surface，也不得使用会强制施加玻璃胶囊的 macOS Toolbar。会话打开时主工作区显示真实会话名称和操作菜单，Project 作用域显示 Project 名称；没有工作对象时不重复 `D Code` 产品名。会话栏开关归属左侧区域，会话身份归属主工作区，信息检查器开关归属右侧区域；三者不得堆叠成多排。空白控制带单击拖动窗口；双击读取 macOS 的“连按窗口标题栏”偏好，并执行放大 / 还原、最小化或无动作，不得硬编码成单一行为，也不得被拖拽手势吞掉。
- Session context row（会话上下文行）与 Composer 位于 transcript（对话记录）滚动区之外；会话标题和持久操作不在内容区重复。Composer 以 raised surface 与阅读画布分层，不依赖贯穿中央区的硬分隔线。

## 7. 当前组件规则

### 7.1 Session Sidebar（会话栏）

- Recent 只显示 D Code 来源会话并按需分页；Project 只投影已登记 Source Folder 精确匹配的会话。
- 已置顶会话集中在会话栏所有普通会话列表之前的全局“置顶”区域，并从 Recent 与 Project 普通列表去重；同一稳定 Session ID 始终使用同一置顶与归档状态。
- Recent、Project 与全局置顶区域复用同一个 `SessionNavigationItem`。普通行尾部常显右对齐的相对更新时间（caption、tertiary、monospaced digits）；时间是扫视排序的核心线索，不藏进 Hover。完整标题、Project、Source Folder、完整 `cwd` 与当前 Git 分支仍通过行级 Hover / keyboard focus 的非模态详情呈现。分支只描述当前工作目录，不表示 Session 历史分支。
- 会话栏动词行（“新建会话”“新建项目”）与正文行共用 `36pt` 行高；动词行行尾常显快捷键提示（如 `⌘N`，caption2 等宽、tertiary 色），不藏进菜单。
- Window control band、会话栏身份行、“新建项目”、Project 和 Session 导航行统一使用 `36pt` 行高；紧凑图标动作仍是 `32pt` 目标，不得为了填满行高放大 glyph 或 surface。
- row 的文字区与尾部槽位分离。尾部为 `64pt` 双用途槽位：静止时右对齐显示相对更新时间；Hover / keyboard focus 时时间淡出（保留占位），置顶与归档两个 `32 × 32pt` sibling 按钮在同一槽位翻出覆盖。标题截断边界保持在槽位之前，任何状态不与按钮或时间重叠。
- 外层保留 `8pt` 水平 padding；文字与圆角边缘不得贴边。标题和 metadata 始终保留自己的稳定起点。
- Hover 使用低强度中性圆角面；Selected 使用更强的持久中性面；Keyboard focus 使用 accent outline。三者切换不得改变 row 高度、标题位置或 action rail。
- Hover / focus 显示 pin 与 archive；全局置顶区中的 `pin.fill` 常显。Context menu 与 Session header menu 提供等价操作。
- Archive 是可恢复的 D Code 可见性操作，不修改 Pi JSONL；Trash 只适用于符合安全条件的空 D Code Session。
- 设置与归档管理都不占用日常会话导航。齿轮和 `Command-,` 进入当前窗口内的 Settings 工具页面；该页面临时使用完整工作台画布，以继承会话栏实际宽度的页内设置导航组织“模型 / 本机资源 / 自定义供应商 / 外观 / 工作台 / 已归档会话 / 自构建 / Host 诊断 / 关于 D Code”，右侧正文限制为约 `780pt`，使用少量语义分组与整行控件，而不是一张铺满窗口的表或卡片瀑布。设置页内拖动左侧边缘会更新全局共享宽度，返回 Workspace 后会话栏立即采用同一宽度。进入设置期间隐藏日常会话栏和信息检查器，但只暂时让出空间，不改写它们的显示偏好；返回 Workspace 后恢复。已归档会话复用同一设置外壳与页内导航，不得叠加 Sheet、卡片式弹窗或第二窗口。“关于 D Code”也复用该外壳，集中显示 App 图标、版本 / 构建号、作者 GitHub 与项目 GitHub，不为静态身份资料新开窗口。

### 7.2 Information Inspector 与 Project Files

- Project 只有一个 Source Folder 时，Files 直接把该根的 children 作为首层；存在多个 Source Folder 时才显示各根行，来源身份不得因平铺而丢失。
- 文件树行 Hover 使用低强度中性圆角面，不改变行高或缩进；右键 Context menu 提供“引用到输入框”“在 Finder 中显示”与“拷贝路径”等动作，与行级 help 等价可达。行可获键盘焦点（accent 焦点环），目录行 → 展开、← 收起、回车触发行默认动作，与 Hover / 右键等价可达。
- Project 所属 Session 的信息检查器同时提供 Files、Changes 与 Session 概览。Session 只叠加运行上下文，不得让用户失去 Project 文件和 Git 事实。
- Inspector raised surface 的首行直接列出当前可用的“会话 / 文件 / 变更”视图，不先重复会话或 Project 标题。未归入 Project 的 Session 只显示“会话”；Project 本身只显示“文件 / 变更”。
- 信息检查器在 `≥880pt` 保持非模态，并以内缩 raised surface 悬浮于右侧 rail；右侧 rail 与主工作区 canvas 之间不用整高硬分隔线。

### 7.3 Search overlay（搜索浮层）

- `Command-K` 与会话栏搜索打开同一个原生模态焦点层；被覆盖工作台退出 hit-testing 与 accessibility tree。
- 输入框获得初始焦点；结果按稳定 Session ID 选择，打开失败保留结果。
- Index build、rebuild、query failure、no result 与 target-open failure 分别表达。

### 7.4 Conversation（会话）

- Conversation 是当前 Session 的唯一主页面，不建立名为“对话”的标签。只有至少打开一个本机文件时才出现文件标签带；文件标签带直接沿用 reading canvas 底色，不拥有整条独立背景，关闭最后一个文件后回到主页面。
- Markdown 文件标签提供 源码 / 预览 分段切换（0.0.17，ADR 0025）：预览默认渲染缓冲区文本而非磁盘事实（未保存时明确标注”尚未写盘”）；源码态在未进入编辑时保持 0.0.4 的行号只读呈现（行定位请求优先源码态），进入编辑后为等宽 TextEditor。有未保存修改时标签与标题栏显示脏标识；保存（⌘S）走同目录临时文件原子替换，磁盘冲突以冲突卡三选（重新加载 / 显式覆盖 / 继续编辑）裁决，关闭脏标签必须确认；授权撤销后可继续编辑但保存禁用。
- HTML 文件标签是”编辑缓冲区 | 即时预览”并排双栏（0.0.18，ADR 0026）：打开即进入编辑，无源码 / 预览切换，窄窗口上下堆叠；预览为隔离 WKWebView（nonPersistent 存储），内容从内存缓冲区注入并随编辑停顿自动刷新，内联脚本默认运行；网络默认阻断——外部导航触发”本次允许 / 保持阻止”询问条（仅当前文件预览会话有效），子资源以常驻状态呈现；本机相对资源经 `dcode-asset://` 限定在 Source Folder 授权根内。其余非 Markdown / HTML 文件维持只读行呈现，不提供切换与编辑。
- 失败与恢复呈现（0.0.19，ADR 0027）：中断影响按 已完成 / 未完成 / 未知 三态如实呈现，未知态给核对入口而非自动重试；连接失败态（侧栏红点、主页空态）与 Host 需重启态提供常驻”重新连接 Pi Host”入口；尾部不完整的会话以顶部修复卡呈现（备份并修复后打开 / 取消），不做通用修复；本机存储熔断在 设置 › Host 诊断 › 本机存储状态 常驻可见并提供显式[重试保存]，受影响界面（Composer 草稿、证据区）同步常驻提示；恢复链路的失败步骤以 notice 呈现，不静默。
- 用户消息使用 content-sized、trailing-aligned 的 accent-tinted bubble；助手正文保持无卡片阅读面。
- Markdown 使用原生 block layout 呈现标题、段落、列表、引用、分隔线、表格、强调、链接和代码；复制始终返回原始 source。
- 一个产品工作轮从一条用户消息延续到下一条用户消息。完成后保留最终回答；thinking、工具和中间叙述进入 round disclosure。
- Round disclosure 折叠态是逐步安静摘要：相邻同类步骤合并成一行次级色状态（如「探索 · 3 文件」「已编辑 文件名 目录 +1 −1」「思考过程 持续了 4 秒」「运行命令 · 2 次」），编辑 / 创建按目标文件聚合、不同目标不合并；失败步骤在行内如实标注。摘要行数封顶（8 行），超出以「另有 N 步」收口；点击展开完整思考与工具过程行。
- 完成轮的状态、持久化完成日期、耗时与可确认 token 在 final answer 外部以低对比度常显；复制、路径等操作仍在 Hover / keyboard focus 时渐进出现，全部元信息始终可由 VoiceOver 获取。
- 运行中只展示当前 thinking excerpt 或当前 tool；完成步骤收起为逐步摘要，不堆积永久日志卡。
- Conversation rail 使用中性刻度；点击只滚动，不改变 Session Path 或模型上下文。
- 上下文压缩必须可见（ADR 0024）：`isCompacting` 进行中在会话上下文行显示状态 pill（“正在压缩上下文…”），结束即消失；压缩是影响成本与结果的 harness 行为，不得静默发生。

### 7.5 Native content blocks（原生内容块）

- Fenced code 使用安静表面、语言标记、水平滚动、选择和复制。
- Mermaid 使用语义色、两轴有界滚动、`60–200%` 缩放、源码 / 图片复制与 PNG 导出；失败时显示原始 source。
- Pi 结构化 `image` 内容块使用固定方形缩略图；点击后进入原生原图预览并提供有界缩放。图片原始数据仍只属于 Pi Session JSONL，App 仅在内存中严格 Base64（编码）解码、检查 MIME / 尺寸 / 像素上限，不写缓存或附件副本；失败时显示安全占位。远程 Markdown 图片不进入这条内部路由。
- 识别出的 read / edit / write / search 工具结果使用 D Code 自有安全 presenter；未知工具保留 generic fallback，不显示扩展 TUI。

### 7.6 Composer、作用域托盘与 Active Plan

- Composer 固定在 transcript 下方，以共享 raised surface 悬浮于阅读画布，保留模型、thinking、Fast 和 context usage（上下文圆环只在已创建会话——存在运行上下文——时显示，会话前草稿不显示空环；圆环弹层以「已用 / 窗口」为主数字，构成以分段彩色条与同色图例呈现并带百分比，底部给出自动压缩阈值（窗口 − reserveTokens）与「手动压缩」动作——手动压缩经 Pi 合同真实执行，不放假按钮）；运行冲突不得吞掉草稿。
- 主工作区没有会话打开时，主页即会话前草稿：同一 Composer 组件居中（最大约 `640pt`）落地，启动、新建会话、打开会话与返回工作台时输入框自动获得键盘焦点；首次发送非空正文才创建真实 Pi Session（延迟创建是产品内部机制，不在界面上解说）。主页不显示问候语、建议 prompt 或模板卡片。
- 会话前草稿的 Composer 带作用域托盘：与输入框同一 raised surface 的下挂条，hairline 分隔，承载 Source Folder 选择 chip（默认用户目录 `~`，正文与模型选择随目录迁移保留）与只读 Git 分支 chip（仅当选中 Git 仓库目录时出现）。
- 占位符可以承担教学，但必须先守住视觉预算：走 3.4 的 hint 档（AppKit `tertiaryLabelColor` / SwiftUI `.tertiary`），一行、上限约 18 个全宽字符、最多一条教学子句，不用分号并列两条教学。空输入框的第一眼必须仍然读成"空"。当前文案 `交给 D Code 一项工作，/ 使用命令`；运行中仍按语境显示介入 / 排队占位符。
- 占位符只教已经实现的快捷输入。尚未实现的能力（如 `@` 插入上下文）不在占位符里预告——占位符是输入框的当前契约，不是路线图。
- 发送按钮遵循 4.1 图标动作几何（`28pt` 视觉 / `32pt` 命中区），容器常在、权重分档：可发送时 accent 圆形填充；暂不可发送时保留同尺寸的中性极低填充圆盘（约 `0.07`）与次级色 glyph。禁用态不得退化成没有容器的裸 glyph——那会让主动作在控制行里比旁边的状态指示更弱，用户根本找不到按钮在哪；也不得回到 `36pt` 实心灰盘那种读起来像"可以按"的重量。禁用观感由按钮自己的 style 表达，不依赖系统对 disabled label 的二次变暗：次级色再被压一层会掉到 3.4 的提示档，和占位符同权重。模型 chip 使用 caption 字号与次级视觉，不与正文抢层级。
- `/` 统一命令面板（0.0.20，ADR 0028）：单一面板混排 扩展命令（getCommands）、命令、Skill 与 Prompt 模板（resources.list，同名以 getCommands 为准去重），行尾类型胶囊（扩展 / 命令 / Skill / 模板）、描述单行常显、悬停 help 显示完整描述；面板可滚动（显示上限 12 行、最高约 7 行高度）；↑↓ 选择、高亮、Esc 关闭与回车选中，交互模式与 ⌘K 搜索浮层一致；插入文本复用 0.0.16 `composerInvocationText` 合同——只预填不发送。
- Composer 控制行前置 `+` 附件按钮（0.0.20，ADR 0028）：纯按钮、不携带菜单下拉指示符；图片经系统文件选择器成为附件 chip（文件名 + 体积 + 移除，≤8 张、单张原始字节 ≤5MB，超限给出用户可读原因），随下一条 prompt / steer 经协议 `images` 真实进入模型输入；附件仅内存持有、不进本机 store 与后续消息队列，请求失败随正文一起恢复，受理后与会话切换时清空；非图片文件插入精确路径引用（ADR 0024）。原 `+` 一次性资源菜单退役，资源触达由统一 `/` 面板承接，资源管理仍在 设置 > 本机资源。设置 > 自定义供应商 经 Pi `models.json` 合同管理供应商与模型定义：目标边界是凭据只写不回显、既有值由 Host 合并保留、非法输入字段级报错且零写入；当前 `modelOverrides.<model>.headers` 脱敏缺口在 0.0.16 PRD 中保持未完成，修复前不得把高级 JSON 编辑器视为凭据安全界面。
- 界面即上下文（ADR 0024）：信息检查器的文件行 / Git diff 文件行与 hunk、验证证据行、会话谱系节点与计划工作项提供“引用到输入框”，把精确引用（路径、行区间、增删摘要、命令与 revision）写入当前 Composer 草稿并带回对话页；只预填、不发送，已有内容以空行追加不覆盖，用户仍可编辑并显式发送。设置新增“本机资源”页：按 Pi 真实加载结果展示扩展包（可停用 / 启用，经 Pi 配置写与热重载）、已加载扩展（含注册的工具 / 命令计数）、Skill、Prompt 模板、命令与加载诊断；隐藏的 D Code 内联扩展不出现在用户面。
- Active Plan 位于 transcript 与 Composer 之间；折叠态只显示 objective、current step 与进度，完成或放弃后退出常驻界面。

## 8. Motion 与 Accessibility（无障碍）

- Motion 只用于短状态转换、按压反馈、banner 和 transcript auto-scroll；Reduce Motion 下改为淡入或直接状态变化。
- 文本行、列表选择、 destructive / primary（破坏性 / 主要）动作继续使用不小于 `40 × 40pt` 的稳定目标；顶栏与行尾的紧凑纯图标动作允许使用 `32 × 32pt`，前提是相邻目标不重叠，并同时具备对象化 VoiceOver 名称以及菜单、快捷键或 Context menu（上下文菜单）等价入口。
- 顶栏图标不作为 Tab 键的独立停靠点；其等价键盘路径由会话菜单、命令或快捷键承担，不能用持久蓝色焦点环冒充默认状态。
- 纯图标按钮必须有对象化 label 与 help；选中行添加 `.isSelected`。
- Hover 才出现的动作必须在 keyboard focus 和 context menu 中等价可达。
- Semantic colors 必须支持 Dark Mode、Increase Contrast 与 Reduce Transparency fallback。
- 技术值可选择；VoiceOver 阅读顺序与视觉顺序一致。纯装饰 glyph 隐藏，由按钮拥有动作名称。

## 9. 验收矩阵

自动测试、构建成功不能替代视觉验收。共享组件修改后至少检查：

1. Rest / Hover / Selected / Keyboard focus / Pressed / Disabled 六态；
2. Dark / Light、Increase Contrast、Reduce Motion；
3. 键盘 Tab 顺序、Return / Space 触发、VoiceOver 名称与 selected trait；
4. 普通、长标题、不同消息数和 Project 嵌套层级；
5. Hover 前后标题 `minX/minY`、row 高度和 action rail frame 不变；
6. 同组按钮 hit frame 等高同宽、中心 `y` 误差不超过 `0.5pt`，命中区不重叠；
7. 替换同类 SF Symbol 后无需添加业务页面 offset；
8. 实际 App 截图确认可读密度、边距和 optical alignment（视觉对齐），不能只看 SwiftUI frame。
9. 提示档文本（占位符、空态）在截图上取墨色采样，确认落在 hint 档而非次级档；语义色名不能替代实测——`placeholderTextColor` 就是名字像提示档、实际是 `0.5` 的反例。

当前没有 screenshot test（截图测试）基础设施。涉及视觉结果时，应在最新 source 对应的重新构建 App 中保留截图与人工操作路径，并把自动测试、构建、人工验收、提交和发布分别报告。

## 10. 当前代码入口

- Shared tokens / primitives：`app/Sources/PiDCode/Views/DesignSystem.swift`
- Responsive layout：`RootView.swift`、`WorkbenchModels.swift`
- Sidebar rows：`SidebarView.swift`
- Conversation / Markdown / rail：`ConversationView.swift`、`MarkdownDocumentView.swift`、`ConversationRoundRail.swift`
- Search：`SearchOverlayView.swift`
- Composer / Plan：`ComposerView.swift`、`ActivePlanView.swift`

共享规则变化先修改本文件与共享 primitive。只有某个组件特有且不会重复的几何，才留在对应 View 中。
