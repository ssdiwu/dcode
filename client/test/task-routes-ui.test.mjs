import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "MouseEvent", "getComputedStyle"])
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
const { render, screen, fireEvent, cleanup } = await import("@testing-library/react");
const server = await createServer({ configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)), server: { middlewareMode: true, hmr: false }, appType: "custom" });
const { TaskRouteSummary } = await server.ssrLoadModule("/src/components/TaskRouteSummary.tsx");
await server.close();

test("route summary preserves objections and source navigation, and does not present stale selection as current", () => {
  const candidate = { id: "route-a", title: "流式读取", round: 1, approach: "分段处理", basis: "读取接口已核对", assumptions: ["可以分段"], failureConditions: ["边界字符丢失"], probe: "跨段测试", expectedCost: "一次检查", dependencies: "读取接口", remainingWork: ["实现并回归"] };
  const route = { version: 1, question: "怎样降低内存", status: "ready", round: 1, reason: "已检查主要前提", selectedCandidateId: candidate.id, budget: { rounds: 2, candidates: 3, checks: 4 }, candidates: [candidate], checks: [{ id: "check", candidateId: candidate.id, actorAgentRunId: "reviewer", outcome: "ready", summary: "边界条件已核对", findings: [], evidenceIds: ["proof"] }], history: [{ action: "begin", reason: "探索内存问题" }, { action: "invalidate", reason: "保留前一轮失败原因" }] };
  const snapshot = { taskPlans: [{ id: "plan", taskId: "task", state: "active", routeContextCurrent: true, document: { routeExploration: route } }], agentRuns: [{ id: "reviewer", taskId: "task", sessionId: "member-session" }], evidence: [{ id: "proof", taskId: "task", commandRedacted: "read", exitKind: "ok" }] };
  let opened;
  try {
    const view = render(React.createElement(TaskRouteSummary, { snapshot, taskId: "task", onMember: id => { opened = id; } }));
    assert.ok(screen.getByText("路线已采用，成果待验证"));
    assert.ok(screen.getByText("保留前一轮失败原因"));
    for (const details of document.querySelectorAll("details")) details.open = true;
    fireEvent.click(screen.getByRole("button", { name: "查看检查成员的对话" }));
    assert.equal(opened, "member-session");
    snapshot.taskPlans[0].routeContextCurrent = false;
    view.rerender(React.createElement(TaskRouteSummary, { snapshot, taskId: "task", onMember: () => {} }));
    assert.ok(screen.getByText("任务要求已变更，路线待复核"));
    assert.equal(screen.queryByText("采用：流式读取"), null);
    assert.ok(screen.getByText("保留前一轮失败原因"));
    snapshot.taskPlans[0].routeContextCurrent = true;
    snapshot.taskPlans[0].routeInputCurrent = false;
    view.rerender(React.createElement(TaskRouteSummary, { snapshot, taskId: "task", onMember: () => {} }));
    assert.ok(screen.getByText("有新输入，路线待核对"));
    assert.equal(screen.queryByText("采用：流式读取"), null);
    route.status = "invalidated";
    delete route.selectedCandidateId;
    view.rerender(React.createElement(TaskRouteSummary, { snapshot, taskId: "task", onMember: () => {} }));
    assert.ok(screen.getByText("原路线已失效"));
    assert.ok(screen.getByText("还有用户新输入待协调者核对。"));
    view.rerender(React.createElement(TaskRouteSummary, { snapshot, taskId: "other-task", onMember: () => assert.fail("cross-task") }));
    assert.equal(document.querySelector(".task-route-summary"), null);
  } finally { cleanup(); }
});
