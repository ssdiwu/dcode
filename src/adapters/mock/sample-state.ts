// 首次启动的种子内容：一个示例工作空间和一条已完成的开发会话。
// 全部为模拟内容，仅用于原型验证；不代表真实执行。

import type { PersistedState } from "@/application";

const T = 1_759_000_000_000; // 固定的演示时间基准

export function sampleState(): PersistedState {
  const homeDefaultTask = {
    id: "task-home-default",
    workspaceId: "ws-home",
    parentId: null,
    kind: "long" as const,
    title: "默认任务",
    boundFolder: null,
    isDefault: true,
    updatedAt: T + 9000,
  };
  const demoSessionId = "session-demo-main";
  return {
    workspaces: [
      { id: "ws-home", name: "Home", folders: ["~"], builtinHome: true, defaultTaskId: homeDefaultTask.id },
      {
        id: "ws-dcode",
        name: "D Code",
        folders: ["~/Workspace/Codes/Apps/dcode", "~/Workspace/Codes/Apps/dcode-web"],
        builtinHome: false,
        defaultTaskId: "task-dcode-default",
      },
    ],
    tasks: [
      homeDefaultTask,
      {
        id: "task-dcode-default",
        workspaceId: "ws-dcode",
        parentId: null,
        kind: "long" as const,
        title: "默认任务",
        boundFolder: null,
        isDefault: true,
        updatedAt: T + 8000,
      },
      {
        id: "task-workbench",
        workspaceId: "ws-dcode",
        parentId: null,
        kind: "long" as const,
        title: "重构工作台 UI",
        boundFolder: "~/Workspace/Codes/Apps/dcode",
        isDefault: false,
        updatedAt: T + 7000,
      },
      {
        id: "task-fontsize",
        workspaceId: "ws-dcode",
        parentId: "task-workbench",
        kind: "short" as const,
        title: "字号设置改为步进器",
        boundFolder: null,
        isDefault: false,
        updatedAt: T + 6000,
      },
      {
        id: "task-readme",
        workspaceId: "ws-home",
        parentId: null,
        kind: "long" as const,
        title: "整理读书笔记",
        boundFolder: null,
        isDefault: false,
        updatedAt: T + 5000,
      },
    ],
    sessions: [
      { id: demoSessionId, taskId: "task-fontsize", title: "字号步进器与默认值", kind: "main", updatedAt: T + 6000 },
      { id: "session-home-1", taskId: "task-home-default", title: "聊聊下个季度的规划", kind: "main", updatedAt: T + 4000 },
      { id: "session-readme-1", taskId: "task-readme", title: "《设计中的设计》摘抄", kind: "main", updatedAt: T + 3000 },
    ],
    timelines: {
      [demoSessionId]: demoTimeline(),
      "session-home-1": [
        {
          kind: "message",
          id: "m-h1",
          role: "user",
          text: "帮我理一下下个季度想做的三件事，按投入和收益排个序。",
          streaming: false,
          at: T + 3000,
        },
        {
          kind: "message",
          id: "m-h2",
          role: "assistant",
          text: "先给结论：建议按「D Code 重设计 > 写作流沉淀 > 对外分享」排序。\n\n理由：D Code 是你每天用的工具，投入直接复利到所有其他工作；写作流已经有碎片积累，季度内能看到成品；对外分享依赖前两项的产出，放在最后不损失什么。\n\n要不要我把每项拆成可验收的两周目标？",
          streaming: false,
          at: T + 3100,
        },
      ],
      "session-readme-1": [
        {
          kind: "message",
          id: "m-r1",
          role: "user",
          text: "把《设计中的设计》第三章的要点整理成五条摘抄，每条配一句我自己的批注。",
          streaming: false,
          at: T + 2500,
        },
        {
          kind: "message",
          id: "m-r2",
          role: "assistant",
          text: "整理好了，五条摘抄如下：\n\n1. 「设计不是装饰，是让事物变得易懂。」——批注：对应我们做工具时的渐进披露。\n2. 「再设计的起点是日常用品。」——批注：工作台就是开发者的日常用品。\n3. 「空白不是无，是可能性。」——批注：空态设计的依据。\n4. 「触感先于视觉。」——批注：交互反馈比静态好看更重要。\n5. 「设计师的角色是编辑。」——批注：做减法的过程。\n\n需要展开哪一条继续说。",
          streaming: false,
          at: T + 2600,
        },
      ],
    },
    runs: {
      [demoSessionId]: { sessionId: demoSessionId, status: "ready", note: "历史演示内容（模拟）", pendingInputs: 0, updatedAt: T + 6000 },
      "session-home-1": { sessionId: "session-home-1", status: "ready", note: "历史演示内容（模拟）", pendingInputs: 0, updatedAt: T + 4000 },
      "session-readme-1": { sessionId: "session-readme-1", status: "ready", note: "历史演示内容（模拟）", pendingInputs: 0, updatedAt: T + 3000 },
    },
    settings: { theme: "system", fontSize: 14, coldStart: "restore", language: "system" },
    model: { configured: false, label: null, simulated: true },
    pendingFirstSends: {},
  };
}

function demoTimeline(): PersistedState["timelines"][string] {
  const at = (offset: number) => T + 1000 + offset;
  return [
    {
      kind: "message",
      id: "m-d1",
      role: "user",
      text: "把设置页的字号设置从下拉框改成 13–16 的步进器，默认值从 15 改成 14。改完跑一遍输入控件测试。",
      streaming: false,
      at: at(0),
    },
    {
      kind: "message",
      id: "m-d2",
      role: "assistant",
      text: "我先找字号设置的现有实现和 token 定义，确认默认值在哪里生效，再动手改。\n\n计划：\n1. 定位设置页控件与 `--ui-font-size` 的定义处；\n2. 把控件换成步进器，范围 13–16；\n3. 默认值改为 14，核对派生刻度；\n4. 跑输入控件测试验证。",
      streaming: false,
      at: at(10),
    },
    {
      kind: "tool",
      id: "t-d1",
      tool: {
        name: "search",
        primaryText: "搜索 \"ui-font-size\" 与 \"字号\" 相关文件",
        output: "找到 3 个相关文件：\n- src/renderer/styles.css:45  --ui-font-size: 15px;\n- src/renderer/components/SettingsRow.tsx:12  FontSizeSelect 组件\n- src/renderer/views/SettingsPage.tsx:88  字号设置行（下拉框）\n\n测试文件：\n- test/layout/input-focus.mjs  输入控件焦点测试（260 断言）",
        status: "done",
        changedFiles: [],
      },
      at: at(20),
    },
    {
      kind: "tool",
      id: "t-d2",
      tool: {
        name: "read",
        primaryText: "读取 SettingsPage.tsx 与 styles.css 相关段落",
        output: "SettingsPage.tsx:80-96\n  <SettingsRow label=\"界面字号\">\n    <Select value={fontSize} …>\n      <option value={13}>13</option>\n      …\n    </Select>\n  </SettingsRow>\n\nstyles.css:40-52\n  :root {\n    --ui-font-size: 15px;\n    --text-ui-base: var(--ui-font-size);\n    --text-ui-lg: calc(var(--ui-font-size) + 2px);\n    …\n  }",
        status: "done",
        changedFiles: [],
      },
      at: at(30),
    },
    {
      kind: "message",
      id: "m-d3",
      role: "assistant",
      text: "找到了：字号定义在 `styles.css:45`（当前 15px），控件是 `SettingsPage.tsx:88` 的下拉框。现在改成步进器并调默认值。",
      streaming: false,
      at: at(40),
    },
    {
      kind: "tool",
      id: "t-d3",
      tool: {
        name: "edit",
        primaryText: "SettingsPage.tsx — 下拉框换成步进器",
        output: "",
        status: "done",
        changedFiles: ["src/renderer/views/SettingsPage.tsx"],
      },
      at: at(50),
    },
    {
      kind: "tool",
      id: "t-d4",
      tool: {
        name: "edit",
        primaryText: "styles.css — --ui-font-size 默认值 15px → 14px",
        output: "",
        status: "done",
        changedFiles: ["src/renderer/styles.css"],
      },
      at: at(60),
    },
    {
      kind: "tool",
      id: "t-d5",
      tool: {
        name: "execute",
        primaryText: "npm run test:inputs",
        output: "$ npm run test:inputs\n\n> vite build && node test/layout/input-focus.mjs\n\n✓ 51 个输入定义\n✓ 260/260 断言通过\n\n耗时 4.2s",
        status: "done",
        exitCode: 0,
        changedFiles: [],
      },
      at: at(80),
    },
    {
      kind: "change-summary",
      id: "c-d1",
      files: [
        {
          path: "src/renderer/views/SettingsPage.tsx",
          added: 18,
          deleted: 9,
          hunks: [
            {
              header: "@@ -85,14 +85,23 @@",
              lines: [
                { type: "context", text: "  <SettingsRow label=\"界面字号\" hint=\"全部界面几何由此派生\">" },
                { type: "del", text: "    <Select value={fontSize} onChange={onFontSize}>" },
                { type: "del", text: "      {[13, 14, 15, 16].map((n) => (" },
                { type: "del", text: "        <option key={n} value={n}>{n}px</option>" },
                { type: "del", text: "      ))}" },
                { type: "del", text: "    </Select>" },
                { type: "add", text: "    <Stepper" },
                { type: "add", text: "      value={fontSize}" },
                { type: "add", text: "      min={13}" },
                { type: "add", text: "      max={16}" },
                { type: "add", text: "      step={1}" },
                { type: "add", text: "      unit=\"px\"" },
                { type: "add", text: "      onChange={onFontSize}" },
                { type: "add", text: "      aria-label=\"界面字号\"" },
                { type: "add", text: "    />" },
                { type: "context", text: "  </SettingsRow>" },
              ],
            },
          ],
        },
        {
          path: "src/renderer/styles.css",
          added: 1,
          deleted: 1,
          hunks: [
            {
              header: "@@ -43,3 +43,3 @@",
              lines: [
                { type: "context", text: ":root {" },
                { type: "del", text: "  --ui-font-size: 15px;" },
                { type: "add", text: "  --ui-font-size: 14px;" },
                { type: "context", text: "}" },
              ],
            },
          ],
        },
        {
          path: "src/renderer/components/Stepper.tsx",
          added: 42,
          deleted: 0,
          hunks: [
            {
              header: "@@ -0,0 +1,42 @@（新文件）",
              lines: [
                { type: "add", text: "export function Stepper({ value, min, max, step, unit, onChange, ...rest }) {" },
                { type: "add", text: "  const clamp = (n: number) => Math.min(max, Math.max(min, n));" },
                { type: "add", text: "  return (" },
                { type: "add", text: "    <div className=\"stepper\" role=\"spinbutton\" aria-valuenow={value} {...rest}>" },
                { type: "add", text: "      <IconButton icon=\"minus\" onClick={() => onChange(clamp(value - step))} />" },
                { type: "add", text: "      <span className=\"stepper-value\">{value}{unit}</span>" },
                { type: "add", text: "      <IconButton icon=\"plus\" onClick={() => onChange(clamp(value + step))} />" },
                { type: "add", text: "    </div>" },
                { type: "add", text: "  );" },
                { type: "add", text: "}" },
              ],
            },
          ],
        },
      ],
      at: at(90),
    },
    {
      kind: "message",
      id: "m-d4",
      role: "assistant",
      text: "完成。改动三个文件：\n\n- `SettingsPage.tsx`：下拉框替换为步进器（13–16，步进 1，带 `spinbutton` 语义）；\n- `styles.css`：`--ui-font-size` 默认值 15 → 14，派生刻度不用动；\n- 新增 `Stepper.tsx` 共享组件。\n\n输入控件测试 260/260 通过，焦点规则没有回归。你可以打开设置页实际调一下字号，所有列表和行高应该一起缩放。",
      streaming: false,
      at: at(100),
    },
  ];
}
