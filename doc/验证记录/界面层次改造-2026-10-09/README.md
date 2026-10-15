# 界面层次改造与成熟组件接入（2026-10-09）

本轮由 MiniMax Code 在主目录实施：把「太平、像临时拼装」的工作台改成有层次的工作环境，并按 DESIGN 的组件来源实际接入 vercel/ai-elements 与 shadcn/ui 的成熟组件。本文只记录改了什么、用了哪些上游、改前改后证据、以及仍未覆盖的边界。产品要求仍以 spec 为准。

## 基线与协作前提

交接描述的基线（分支 `codex/redesign-2026-10-03`、HEAD `15917d1`、src/test 未跟踪、本地与远端 main 均为 `456a1c2`）在开工前已不成立。核对到的实际状态：

- 分支 `main`，HEAD `5a5ea29`，与 `origin/main` 一致，工作树干净（`git status --porcelain` 为空）。
- `src/`（47 个文件）与 `test/`（58 个文件）已被 Git 跟踪并提交；旧历史 `456a1c2` 是 main 的祖先，`15917d1` 是祖先提交。
- 因此本轮**不需要**额外备份：完整可恢复基线就是已推送的 `5a5ea29`，不存在未跟踪源码丢失的风险。
- 本轮未新建工作树、未切换分支、未 reset/clean、未触碰 `codex/components-slice-2026-10-07`（该树仍停在 `15917d1`，由原写入者继续）。

## 采用的上游组件

来源、版本、逐文件 SHA256 与本地修改见 [第三方材料](../../THIRD_PARTY_NOTICES.md#本片移植的组件文件2026-10-09-界面层次与成熟组件接入)。

| 上游 | 组件 | 处置 |
|---|---|---|
| shadcn/ui（MIT，经 ai-elements 再发布） | `input-group.tsx`、`collapsible.tsx` | 移植并适配到 D Code token；焦点只保留一个框 |
| vercel/ai-elements（Apache-2.0） | `message.tsx`（Message / MessageContent / MessageResponse） | 移植，删去分支与消息操作，插件只留 cjk |
| vercel/ai-elements | `code-block.tsx` | 移植，删语言选择器；shiki 改按需加载 |
| vercel/ai-elements | `prompt-input.tsx` | 移植结构，删附件/Provider/Submit；**删除「提交即清空」** |
| vercel/ai-elements | `tool.tsx` | 移植折叠结构，删 ToolInput 与上游状态文案 |

未引入：`@streamdown/math`、`@streamdown/mermaid`、`ai`、`use-stick-to-bottom`、`nanoid`、`class-variance-authority`、`@streamdown/code`。Model Selector 按交接要求不接入（真实模型目录接口未就绪，不拿静态列表冒充）。

## 必须保留的行为，逐条核对

- 执行底座仍是 Pi SDK 1.0.0；未引入 AI SDK 聊天后端，`ai` 只在上游类型里出现且已改为本地类型声明。
- 界面仍只通过 `window.dcode` 现有契约读状态、发操作；没有新增消息队列或执行状态。
- C01 主按钮状态表（`derivePrimaryAction`）逐字保留；主按钮仍是 `type="button"`，Enter 只经表单提交尝试发送，不会触发暂停或继续。
- 上游默认的「提交即清空」被删除：草稿只在 `accepted` 回执后由 App 清除；未接收保留原文与重试入口，待核对保留原文并只在原消息回查。
- 菜单内暂停、暂停/继续、恢复条语义未改。
- 真实模型配置表单、加密保存与错误反馈未改；D02 的「去设置」直接落到模型分区。
- 未新增权限模式、主会话审批、「结束本轮」按钮；未实现的侧问／协作／终端仍为待办，无可点无反应的入口。

## 设计变量与文档同步

`DESIGN.md` 同步了三处：颜色与信息层级（新增抬升/下沉/玻璃三组表面与 `--edge`）、容器与磨砂的适用位置与降级、具体样式表（新增 `--raised`/`--sunken`/`--edge`/`--edge-strong`/`--glass-*` 两主题值与 `shadow-float`/`shadow-veil`/`shadow-inset-well`）。`--border`、`--selected`、`--hover`、`focus-ring` 等既有被断言值未改动。

`architecture-policy.json` 的 renderer externals 增列 `@radix-ui/react-collapsible`、`streamdown`、`@streamdown/cjk`、`shiki`，并已同步 THIRD_PARTY_NOTICES。

## 实际通过的检查

| 检查 | 入口 | 结果 |
|---|---|---|
| 架构 | `npm run verify:architecture` | PASS，49 个源文件，7 个模块 |
| 类型 | `npm run typecheck` | 通过 |
| Lint | `npm run lint` | 通过 |
| 构建 | `npm run build` | 通过 |
| 运行集成 | `npm run test:runtime` | 40/40 |
| 契约 | `npm run test:contracts` | 4/4 |
| 界面端到端 | `node --test test/e2e/*.test.mjs` | **65/65**，全部后台隐藏、不可聚焦 |

全部端到端用例在后台隐藏窗口运行，未获取系统焦点。期间在 `components-slice` 工作树有另一会话并发运行它自己的用例，两个应用使用各自隔离的状态目录，未争用同一窗口。

### 本轮改动过的测试及其依据

| 测试 | 改了什么 | 依据 |
|---|---|---|
| `cold-start.test.mjs` | 原来断言首屏**不存在**「去设置」；改为断言它存在、只导航不伪造表单、往返后草稿保留 | 现行 spec D02 要求缺配置内联给出真实配置位置；旧断言与该条冲突，按 spec 更新 |
| `composer-run-states.test.mjs` | 用户消息块定位由 `div.bg-card` 改为 `[data-slot="message"][data-from="user"]` | 类名会随视觉改造失效，改用稳定行为锚点 |
| `send-receipts.test.mjs` | 同上两处（用户消息块、末尾正文容器 `.leading-relaxed` → `[data-slot="message-body"]`） | 同上 |
| `visual-matrix.mjs` | 输出目录支持 `DCODE_VISUAL_SHOTS_DIR` / `DCODE_VISUAL_META_DIR` | 让同一份工装能分别跑改前基线与本轮，互不覆盖 |

## 改前／改后渲染证据

同一工装、同一隔离 mock 装配、同一隐藏窗口：`before/` 为 `5a5ea29` 快照的 18 张，`after/` 为本轮 9 张（zh/en × 浅/深 × 13/14px × 1440/1100/720 紧凑）。每组含草稿态、时间线与检查器、焦点三张。

`meta/before-observations.json` 与 `meta/after-observations.json` 是工装读回的真实 model/execution、settings、DOM 语言/主题/字号/视口与场景到达记录。

实际看图确认到的差别（不是靠截图数量或类名变化推断）：

- 首屏：标题从页面级降到区块标题档，工作位置与问候合并为一行辅助，输入卡片成为视觉主体。
- 消息正文：列表、编号、行内代码、表格与代码围栏按真实 Markdown 结构渲染；改前是逐行段落，行内代码以灰底方块散落。
- 工具块：名称、可截断摘要、文件计数、状态徽标、展开箭头各自成层且右对齐；改前状态词被卷在摘要尾部。
- 差异检查器：文件头抬升、差异正文下沉（内阴影而非描边）；改前是两层带边框的盒子。
- 会话标题带与侧栏使用真实磨砂（窗口本身透明，桌面内容确实在其后）。

## 体积取舍（实测数字）

renderer 主包由 **935 kB 增至约 1.99 MB**，增量主要是 Streamdown 的 Markdown 管线（micromark/mdast/hast/rehype），这是接入 MessageResponse 的必要成本。Shiki 引擎（约 380 kB 独立 chunk）与 300+ 语言分片已拆为按需 chunk，**首屏不加载**；只有界面出现代码块时才 `import("shiki")`。因此本轮**没有**把语法高亮的开销算进首屏。

## 独立只读复核（507-review）

由独立 verifier 只读复核，未修改项目文件。结论：**达到可交付标准，但发现 1 项应修**，已在本轮修掉。

复核确认无问题的项（其独立取证）：Enter 仅走 `trySend`；`event.detail >= 2` 双击防重仍在；`derivePrimaryAction` 未改；`handleSend` 仅在 accepted + 同身份 + 未被改写时清草稿，未知回执保留原文；Timeline 无关键词清洗、滚动段无 diff；DraftState 无虚构记录、「去设置」只导航；`--raised/--sunken/--edge/--glass-*` 浅深两套齐备，`prefers-reduced-transparency` 降级存在；焦点单框成立；6 个上游文件 SHA256 与 GitHub `6a9d5b1` 实取逐一吻合；math/mermaid/code/use-stick-to-bottom/cva 在 package.json 与 lock 中均无（nanoid 仅 dev 传递）；`src/application`、`contracts`、`main`、`preload`、`adapters` 无改动；无权限模式／审批／结束本轮入口；未触碰 components-slice 工作树。

### 复核发现与本轮处理

| 严重度 | 发现 | 本轮处理 |
|---|---|---|
| 应修 | `Composer.tsx` 主按钮漏写 `type="button"`，在 `<form>` 内按宿主默认成为 `submit`。实测 `getAttribute("type")=null`、`button.type="submit"`、`closest("form")` 为真。暂停后带草稿点「继续执行」会连带提交表单，把草稿一起发出去，违反 spec C01「不顺带提交新草稿」。复核当时未观察到实际误发，但该保证此前依赖未被断言的宿主行为 | 已加 `type="button"`，并把回归断言写进已有的「暂停中带草稿 → 点继续执行」场景（DOM 形状 + 表单提交计数 + 用户消息条数三条）。以负样本验证：临时去掉该属性后该用例失败 |
| 建议 | `architecture-policy.json` 仍登记 `@streamdown/code`，但该包已不在 package.json／lock，renderer 也无 import，与 THIRD_PARTY_NOTICES 的「未引入」自相矛盾 | 已从 externals 移除 |
| 建议 | `cold-start` 注释称「落到模型分区本身」，实际只断言存在 `input[type=password]`，弱于声明 | `SettingsPage` 分区按钮加 `aria-current="page"`，测试改为断言模型分区确为当前分区 |
| 建议 | Composer 同时有 `ring-1 ring-[var(--edge)]` 与 InputGroup 的 `border`，同一容器两层同心描线 | 去掉 ring，只保留一条边界 |

### 复核未能核实的部分

- 点「继续执行」是否真的发出 resume（复核只证明了未误发送、未触发表单提交）。
- 用户原文经 Streamdown 按 Markdown 渲染后的保真度与是否被净化。
- 前台焦点、极端 GPU 下的玻璃降级、507 的视觉接受。

## 本轮发现但未修的既有缺口

**跑一次 `npm run verify` 会覆盖往轮验证记录的证据产物。** 10 个 E2E 用例把输出路径硬编码到带日期的历史记录目录：

- `brand-owl.test.mjs` → `品牌猫头鹰-2026-10-08/evidence`
- `keyboard-tree.test.mjs` → `产品自有内容清理-2026-10-07/evidence/{style-2026-10-06,composer-card-2026-10-06}`
- `model-setup.test.mjs` → `模型首次添加-2026-10-09/evidence`
- `product-owned-content.test.mjs` → `产品自有内容清理-2026-10-07/evidence/product-content`
- `scroll-reading-intent.test.mjs`、`visual-matrix.mjs`、`streaming-sim.test.mjs` → `滚动阅读与视觉矩阵-2026-10-08/evidence`
- `scroll.test.mjs`、`send-receipts.test.mjs` → `产品自有内容错误补修-2026-10-07/integration-observations/evidence`
- `settings-error-occurrence.test.mjs` → `产品自有内容错误补修-2026-10-07`
- `style-geometry.test.mjs` → `产品自有内容清理-2026-10-07/evidence/style-2026-10-06`
- 另有 `test/e2e/evidence/` 下的若干 PNG／JSON 同属被复写对象

后果：任何一轮跑完 verify，往轮记录里的截图与几何 JSON 会被当前构建的产物静默替换，旧记录与其当时的结论不再对应。本轮发现时已把这些文件恢复到 `5a5ea29`，本轮证据另存本目录。

**未在本轮修改**，原因：改这 10 个用例的证据路径会动到历史记录结构，且本轮另有会话正在写主目录文档（见下）。建议后续把这些输出根路径统一改为可由环境变量覆盖（`visual-matrix.mjs` 本轮已按此改造，可作范例），或改为写入 `test/e2e/screenshots/` 这类不跟踪的运行产物目录。

## 协作现状（需要 507 决定）

交接称「Codex 主会话完成交接后停止主目录写入；协调者已确认暂缓主目录产品和正式文档写入」。实测**在本次交付期间，主目录仍有另一会话在写文档**：`README.md`、`spec/开发任务路径.md`、`doc/协作约定.md`、`doc/架构约定.md`、`doc/Pi-1.0.0-虚拟模型与运行恢复.md` 以及 `PROGRESS.md` 的部分行，内容为「Pi coding-agent 能力复用基准」。本轮**没有**触碰或回滚这些改动，也没有重写它们的结论。

`PROGRESS.md` 同时含有本轮与该会话的两方改动，两方都只是对既有行的局部替换，没有互相覆盖。若后续要分批提交，需要按内容而非按文件拆分。

## 仍未覆盖的边界

- **没有**接入 Model Selector（真实模型目录接口未就绪，属另一会话在 `components-slice` 的候选）。
- **没有**整体移植 Conversation：现有滚动实现持有「上翻阅读意图 + 几何快照区分真实滚动与重排锚定」的行为，替换会损失它；本轮按需对照。
- 软件合成／低端 GPU 下磨砂的自动降级未实现，只有 `prefers-reduced-transparency: reduce` 这条真实通路。
- 手机布局、侧问、协作图、终端、远端仍按 spec 保留待办。
- 本轮全部证据来自隔离 mock 装配与隐藏窗口；**没有**调用真实外部账户，**没有**做原生前台像素与系统拖选验收，507 的视觉接受仍待人工判断。
