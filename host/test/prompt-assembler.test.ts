import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DCodePromptCredentialError,
  assembleDCodeSystemPrompt,
  loadDCodePromptDocuments,
} from "../src/prompt-assembler.js";

test("D Code Prompt Assembler owns identity, environment, documents and exact active tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-prompt-assembler-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "# Project Rules\n\nUse Chinese.\n");
    await writeFile(join(root, "PRODUCT.md"), "# Product\n\nTask before Session.\n");
    await writeFile(join(root, "DESIGN.md"), "# Design\n\nTask-first.\n");
    await mkdir(join(root, "doc", "40-版本实施方案"), { recursive: true });
    await writeFile(join(root, "doc", "40-版本实施方案", "README.md"), "# PRD Index\n\nChoose the exact PRD.\n");
    const documents = await loadDCodePromptDocuments(root);
    const assembled = assembleDCodeSystemPrompt({
      environment: {
        runtimeId: "runtime-one",
        scope: { kind: "project", projectId: "project-one" },
        taskId: "task-one",
        taskTitle: "Build D Code",
        taskGoal: "Create a native ADE",
        sessionId: "session-one",
        sessionKind: "coordination",
        workspaceId: "workspace-one",
        cwd: root,
        workspaceAccess: "exclusiveWrite",
        modelProvider: "test",
        modelId: "model",
        role: "coordinator",
        roleRevision: "builtin-coordinator:v1",
        roleContract: "Coordinate and synthesize evidence.",
      },
      documents,
      tools: [
        { name: "write", description: "Write a file", parameters: { type: "object" } },
        { name: "read", description: "Read a file", parameters: { type: "object" } },
      ],
    });
    assert.match(assembled.digest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(assembled.tools.map((tool) => tool.name), ["read", "write"]);
    assert.deepEqual(documents.map((document) => document.receipt.path), [
      join(root, "AGENTS.md"),
      join(root, "PRODUCT.md"),
      join(root, "DESIGN.md"),
      join(root, "doc", "40-版本实施方案", "README.md"),
    ]);
    assert.ok(assembled.text.includes("你是 D Code 的 coordinator Agent"));
    assert.ok(assembled.text.includes("Pi SDK 只是本轮 Agent Runtime"));
    assert.ok(assembled.text.includes(`cwd: ${root}`));
    assert.equal(assembled.text.match(/cwd:/g)?.length, 1);
    assert.ok(assembled.text.includes("- read: Read a file"));
    assert.ok(assembled.text.includes("- write: Write a file"));
    assert.ok(assembled.text.includes("Use Chinese."));
    assert.equal(assembled.text.includes("You are Pi"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Prompt documents containing credential material block the Provider boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-prompt-credential-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "token api_key: fixture_value\n");
    await assert.rejects(
      loadDCodePromptDocuments(root),
      (error: unknown) => error instanceof DCodePromptCredentialError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
