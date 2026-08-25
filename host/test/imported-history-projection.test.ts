import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMPORTED_HISTORY_BYTES,
  MAX_IMPORTED_HISTORY_ENTRIES,
  normalizeImportedSessionHistoryReceipt,
  projectImportedSessionHistory,
} from "../src/imported-history-projection.js";

const source = {
  dcodeSessionId: "session-dcode",
  sourceSessionId: "pi-source",
  sourceDigest: `sha256:${"a".repeat(64)}`,
  importerVersion: 1,
  sourcePathId: "path-current",
  redactedAtImport: false,
};

test("Imported History Projection keeps only the current bounded visible tail and redacts again", () => {
  const entries = [
    ...Array.from({ length: MAX_IMPORTED_HISTORY_ENTRIES + 2 }, (_, index) => ({
      id: `entry-${index}`,
      sourceEntryId: `source-${index}`,
      messageRole: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `历史条目 ${index}`,
    })),
    {
      id: "entry-secret",
      sourceEntryId: "source-secret",
      messageRole: "assistant" as const,
      content: [
        { type: "thinking", thinking: "must never enter the projection" },
        { type: "toolCallReference", name: "bash", arguments: "must never enter the projection" },
        { type: "text", text: "保留的助手结论。 api_key: supersafefixturevalue" },
      ],
    },
  ];
  const projection = projectImportedSessionHistory({ ...source, entries });
  assert.ok(projection);
  assert.equal(projection.receipt.availableEntryCount, MAX_IMPORTED_HISTORY_ENTRIES + 3);
  assert.equal(projection.receipt.includedEntryCount, MAX_IMPORTED_HISTORY_ENTRIES);
  assert.equal(projection.receipt.omittedEntryCount, 3);
  assert.equal(projection.receipt.redactedAtProjection, true);
  assert.match(projection.text, /保留的助手结论。 \[REDACTED\]/);
  assert.equal(projection.text.includes("历史条目 0"), false);
  assert.equal(projection.text.includes("must never enter the projection"), false);
  assert.equal(projection.text.includes("supersafefixturevalue"), false);
  assert.equal(projection.receipt.includedBytes, Buffer.byteLength(projection.text, "utf8"));
  assert.match(projection.receipt.digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(normalizeImportedSessionHistoryReceipt(projection.receipt), projection.receipt);
});

test("Imported History Projection truncates one oversized latest entry instead of injecting unbounded text", () => {
  const projection = projectImportedSessionHistory({
    ...source,
    entries: [{
      id: "entry-long",
      messageRole: "user",
      content: "x".repeat(MAX_IMPORTED_HISTORY_BYTES * 2),
    }],
  });
  assert.ok(projection);
  assert.equal(projection.receipt.includedEntryCount, 1);
  assert.equal(projection.receipt.truncatedEntryCount, 1);
  assert.ok(projection.receipt.includedBytes <= MAX_IMPORTED_HISTORY_BYTES);
  assert.match(projection.text, /此条历史已按上下文上限截断/);
});

test("Imported History Projection does not turn tool/image references into model-visible history", () => {
  const projection = projectImportedSessionHistory({
    ...source,
    entries: [{
      id: "entry-tool-only",
      messageRole: "assistant",
      content: [{ type: "toolCallReference", name: "bash", argumentsOmitted: true }],
    }],
  });
  assert.equal(projection, undefined);
});
