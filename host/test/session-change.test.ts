import assert from "node:assert/strict";
import test from "node:test";
import { structuredToolChange } from "../src/session-change.js";

test("projects a successful structured edit into a bounded session change record", () => {
  const change = structuredToolChange({
    sessionId: "session-a",
    runId: "run-a",
    pathEntryId: "user-a",
    cwd: "/tmp/project",
    toolCallId: "tool-a",
    toolName: "edit",
    args: { input: "[Sources/Foo.swift#AABBCCDD]" },
    result: {
      content: [{ type: "text", text: "Updated Sources/Foo.swift" }],
      details: {
        diff: "display only",
        patch: [
          "--- Sources/Foo.swift",
          "+++ Sources/Foo.swift",
          "@@ -2,2 +2,3 @@",
          " keep",
          "-old",
          "+new",
          "+added",
        ].join("\n"),
        firstChangedLine: 2,
      },
    },
    isError: false,
    occurredAt: "2026-08-14T10:00:00.000Z",
  });

  assert.deepEqual(change, {
    recordId: "session-a:run-a:tool-a",
    sessionId: "session-a",
    runId: "run-a",
    pathEntryId: "user-a",
    toolCallId: "tool-a",
    operation: "edit",
    filePath: "/tmp/project/Sources/Foo.swift",
    firstChangedLine: 2,
    additions: 2,
    deletions: 1,
    occurredAt: "2026-08-14T10:00:00.000Z",
    source: "structured-tool-v1",
  });
});

test("projects a DHashline create without retaining file content", () => {
  const change = structuredToolChange({
    sessionId: "session-a",
    runId: "run-b",
    cwd: "/tmp/project",
    toolCallId: "tool-b",
    toolName: "write",
    args: { path: "README.md", content: "secret source body" },
    result: {
      content: [{ type: "text", text: "Created README.md" }],
      details: { path: "README.md", tag: "AABBCCDD", lines: 3, bytes: 42, created: true },
    },
    isError: false,
    occurredAt: "2026-08-14T10:01:00.000Z",
  });

  assert.equal(change?.operation, "create");
  assert.equal(change?.filePath, "/tmp/project/README.md");
  assert.equal(change?.additions, 3);
  assert.equal(change?.deletions, 0);
  assert.equal(JSON.stringify(change).includes("secret source body"), false);
});

test("rejects failed and unstructured tool results instead of guessing", () => {
  const base = {
    sessionId: "session-a",
    runId: "run-a",
    cwd: "/tmp/project",
    toolCallId: "tool-a",
    toolName: "edit",
    args: {},
  } as const;
  assert.equal(structuredToolChange({
    ...base,
    result: { details: { patch: "--- a\n+++ a\n@@ -1 +1 @@\n-old\n+new" } },
    isError: true,
  }), undefined);
  assert.equal(structuredToolChange({
    ...base,
    result: { content: [{ type: "text", text: "edited probably" }] },
    isError: false,
  }), undefined);
  assert.equal(structuredToolChange({
    ...base,
    toolName: "bash",
    result: { details: { patch: "--- a\n+++ a\n@@ -1 +1 @@\n-old\n+new" } },
    isError: false,
  }), undefined);
  assert.equal(structuredToolChange({
    ...base,
    result: { details: { patch: "--- safe\n+++ unsafe\rpath\n@@ -1 +1 @@\n-old\n+new" } },
    isError: false,
  }), undefined);
});
