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
const { ExecutionProcess } = await server.ssrLoadModule("/src/components/conversation/ExecutionProcess.tsx");
const { FileReferenceContext } = await server.ssrLoadModule("/src/workbench/useWorkspaceFiles.ts");
await server.close();

test("tool row keeps concise failure visible and opens the recorded input/output and file source", () => {
  const opened = [];
  const turn = {
    id: "turn", status: "error", hasResponse: true, running: false,
    steps: [{ id: "call-1", kind: "tool", title: "读取文件", toolName: "read", text: '{"path":"src/example.ts"}', output: "ENOENT: source unavailable", state: "error" }],
  };
  try {
    render(React.createElement(FileReferenceContext.Provider, { value: value => opened.push(value) }, React.createElement(ExecutionProcess, { turn })));
    assert.ok(screen.getByText("读取 example.ts · 失败，查看错误"));
    const tool = document.querySelector(".execution-tool");
    assert.equal(tool?.open, false);
    fireEvent.click(tool.querySelector("summary"));
    assert.equal(tool.open, true);
    assert.ok(screen.getByText("ENOENT: source unavailable"));
    assert.ok(screen.getByText('{"path":"src/example.ts"}'));
    fireEvent.click(screen.getByRole("button", { name: "打开来源文件" }));
    assert.deepEqual(opened, ["src/example.ts"]);
  } finally { cleanup(); }
});
