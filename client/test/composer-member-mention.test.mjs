import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "HTMLTextAreaElement", "Node", "Element", "MutationObserver", "Event", "KeyboardEvent", "MouseEvent", "File", "FileReader", "getComputedStyle"])
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
window.dcode = { request: async method => method === "dcodeSession.commands" ? { commands: [] } : { scopeRequired: false, entries: [{ name: "页面.ts", relativePath: "src/页面.ts", reference: "dcode-file:1.abc.def", markdown: "[src/页面.ts](dcode-file:1.abc.def)" }] } };

const React = await import("react");
const { render, screen, fireEvent, cleanup, act, waitFor } = await import("@testing-library/react");
const server = await createServer({ configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)), server: { middlewareMode: true }, appType: "custom" });
const { Composer } = await server.ssrLoadModule("/src/components/Composer.tsx");
await server.close();

const models = { data: { models: [{ key: "m", name: "测试模型", available: true }], selectedKey: "m", thinkingLevels: [] } };
const sessions = [
  { id: "main-1", taskId: "task-1", kind: "coordination", title: "主对话" },
  { id: "main-2", taskId: "task-2", kind: "coordination", title: "另一任务" },
  { id: "child-1", taskId: "task-1", kind: "child", title: "页面实现" },
  { id: "child-2", taskId: "task-1", kind: "child", title: "页面实现" },
  { id: "child-other", taskId: "task-2", kind: "child", title: "外部成员" },
];
const agentRuns = [
  { id: "coordinator", taskId: "task-1", sessionId: "main-1", role: "coordinator", status: "running" },
  { id: "member-1", taskId: "task-1", sessionId: "child-1", role: "worker", status: "running" },
  { id: "member-2", taskId: "task-1", sessionId: "child-2", role: "verifier", status: "completed" },
  { id: "member-other", taskId: "task-2", sessionId: "child-other", role: "worker", status: "running" },
];
let control;

function Harness() {
  const [taskId, setTaskId] = React.useState("task-1");
  const [sessionId, setSessionId] = React.useState("main-1");
  const [runs, setRuns] = React.useState(agentRuns);
  const [drafts, setDrafts] = React.useState({ "main-1": { text: "", images: [], attachments: [] }, "main-2": { text: "", images: [], attachments: [] }, "child-1": { text: "", images: [], attachments: [] } });
  const [sent, setSent] = React.useState([]);
  const [error, setError] = React.useState(null);
  const draft = drafts[sessionId];
  control = {
    draft, sent, setRuns,
    switchTo(task, session) { setTaskId(task); setSessionId(session); },
    setDraft(value) { setDrafts(previous => ({ ...previous, [sessionId]: value })); },
  };
  const work = {
    draft, draftKey: sessionId, task: { id: taskId, state: "active", scope:taskId==="task-1"?{kind:"project",projectId:"project-1"}:{kind:"user",userId:"u"} }, session: sessions.find(item => item.id === sessionId),
    snapshot: { projects: [{id:"project-1",directory:"/tmp/fixture",revision:1}], sessions, agentRuns: runs, sessionRuns: [] },
    error, setError, running: false, sending: false, closing: false, hostDead: false,
    updateDraft: (key, update) => setDrafts(previous => ({ ...previous, [key]: typeof update === "function" ? update(previous[key]) : update })),
    send: (targetAgentRunId, deliveryMode) => setSent(previous => [...previous, { text: draft.text, targetAgentRunId, deliveryMode }]),
    stop() {}, addAttachment: async () => {}, trackAttachmentImport() {}, fail: setError,
  };
  return React.createElement(Composer, { work, models, pathForFile: () => "", onSettings() {} });
}

const type = value => fireEvent.change(screen.getByRole("textbox", { name: "任务消息" }), { target: { value } });
const key = (name, options = {}) => fireEvent.keyDown(screen.getByRole("textbox", { name: "任务消息" }), { key: name, ...options });

test("$ requires explicit member selection and sends to one stable run even with duplicate titles", () => {
  render(React.createElement(Harness));
  try {
    assert.ok(screen.getByRole("button", { name: "选择子代理" }));
    type("请 $");
    assert.ok(screen.getByRole("listbox", { name: "选择子代理" }));
    assert.equal(screen.getAllByRole("option").length, 2);
    assert.equal(screen.getAllByRole("option").every(option => option.getAttribute("aria-selected") === "false"), true);
    key("Enter");
    assert.deepEqual(control.sent, [{ text: "请 $", targetAgentRunId: undefined, deliveryMode: undefined }]);

    type("请 $页面");
    key("ArrowDown");
    key("ArrowDown");
    assert.equal(screen.getAllByRole("option")[1].getAttribute("aria-selected"), "true");
    key("Enter", { isComposing: true });
    assert.equal(control.draft.targetAgentRunId, undefined);
    assert.ok(screen.getByRole("listbox", { name: "选择子代理" }));
    key("Enter");
    assert.equal(control.draft.targetAgentRunId, "member-2");
    assert.equal(control.draft.text, "请 ");
    type("请修复这处问题");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    assert.deepEqual(control.sent.at(-1), { text: "请修复这处问题", targetAgentRunId: "member-2", deliveryMode: undefined });

    type("再交给 $页面");
    fireEvent.click(screen.getAllByRole("option")[0]);
    assert.equal(control.draft.targetAgentRunId, "member-1");
    assert.equal(control.draft.text, "再交给 ");
    fireEvent.click(screen.getByRole("button", { name: "取消定向发送" }));
    assert.equal(control.draft.targetAgentRunId, undefined);
  } finally { cleanup(); }
});

test("$ does not target shell variables, another task, missing members, or a stale selected member", () => {
  render(React.createElement(Harness));
  try {
    type("echo $HOME");
    assert.equal(screen.queryByRole("listbox", { name: "选择子代理" }), null);
    key("Enter");
    assert.deepEqual(control.sent.at(-1), { text: "echo $HOME", targetAgentRunId: undefined, deliveryMode: undefined });

    type("联系 $外部成员");
    assert.equal(screen.queryByRole("listbox", { name: "选择子代理" }), null);
    key("Enter");
    assert.deepEqual(control.sent.at(-1), { text: "联系 $外部成员", targetAgentRunId: undefined, deliveryMode: undefined });

    type("给 $");
    key("ArrowDown");
    key("Enter");
    assert.equal(control.draft.targetAgentRunId, "member-1");
    act(() => control.setRuns(agentRuns.filter(run => run.id !== "member-1")));
    assert.equal(screen.getByRole("button", { name: "发送" }).disabled, true);
    assert.match(screen.getByRole("alert").textContent, /成员.*不可接续/);
    fireEvent.click(screen.getByRole("button", { name: "取消定向发送" }));
    act(() => control.setRuns(agentRuns.filter(run => run.taskId !== "task-1" || run.role === "coordinator")));
    type("$");
    assert.match(screen.getByRole("listbox", { name: "选择子代理" }).textContent, /暂无子代理/);

    act(() => control.switchTo("task-2", "main-2"));
    assert.equal(screen.queryByRole("listbox", { name: "选择子代理" }), null);
    type("联系 $");
    assert.equal(screen.getAllByRole("option").length, 1);
    assert.match(screen.getByRole("listbox", { name: "选择子代理" }).textContent, /外部成员/);
  } finally { cleanup(); }
});

test("child session does not offer $ selection; @ selects a project file without targeting a member", async () => {
  render(React.createElement(Harness));
  try {
    act(() => control.switchTo("task-1", "child-1"));
    type("$");
    assert.equal(screen.queryByRole("listbox", { name: "选择子代理" }), null);
    act(() => control.switchTo("task-1", "main-1"));
    type("@页面");
    await waitFor(()=>assert.ok(screen.getByRole("listbox",{name:"搜索项目文件"})));
    key("Enter");
    assert.deepEqual(control.sent.at(-1),{text:"@页面",targetAgentRunId:undefined,deliveryMode:undefined});
    type("@页面");
    await waitFor(()=>assert.equal(screen.getByRole("listbox",{name:"搜索项目文件"}).querySelectorAll('[role="option"]').length,1));
    key("ArrowDown");
    key("Enter");
    assert.equal(control.draft.targetAgentRunId,undefined);
    assert.equal(control.draft.text,"[src/页面.ts](dcode-file:1.abc.def) ");
  } finally { cleanup(); }
});
