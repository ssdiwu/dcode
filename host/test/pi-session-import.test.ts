import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PiSessionImportError,
  listPiImportCandidates,
  preparePiSessionImport,
} from "../src/pi-session-import.js";
import { D_CODE_SESSION_ORIGIN_TYPE, SessionReader } from "../src/session-reader.js";

async function writeSession(
  sessionsDirectory: string,
  sessionId: string,
  cwd: string,
  dcodeManaged: boolean,
): Promise<void> {
  const directory = join(sessionsDirectory, sessionId);
  await mkdir(directory, { recursive: true });
  const timestamp = "2026-08-25T00:00:00.000Z";
  const entries: unknown[] = [{ type: "session", version: 3, id: sessionId, timestamp, cwd }];
  let parentId: string | null = null;
  if (dcodeManaged) {
    parentId = `${sessionId}-origin`;
    entries.push({
      type: "custom",
      id: parentId,
      parentId: null,
      timestamp,
      customType: D_CODE_SESSION_ORIGIN_TYPE,
      data: { version: 1, sessionId },
    });
  }
  entries.push({
    type: "message",
    id: `${sessionId}-user`,
    parentId,
    timestamp,
    message: {
      role: "user",
      content: "用户提交原文，必须逐字保留。 api_key: fixture_value",
      timestamp: 1,
    },
  });
  entries.push({
    type: "message",
    id: `${sessionId}-assistant`,
    parentId: `${sessionId}-user`,
    timestamp: "2026-08-25T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden chain of thought" },
        { type: "text", text: "可见回答原文。 api_key: fixture_value" },
        { type: "toolCall", id: "tool-1", name: "bash", arguments: { token: "secret" } },
      ],
      timestamp: 2,
    },
  });
  entries.push({
    type: "message",
    id: `${sessionId}-tool-result`,
    parentId: `${sessionId}-assistant`,
    timestamp: "2026-08-25T00:00:02.000Z",
    message: {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "bash",
      content: [{
        type: "text",
        text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz\nAWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwx",
      }],
      isError: false,
      timestamp: 3,
    },
  });
  await writeFile(
    join(directory, `${sessionId}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

test("Pi import candidates exclude sessions already managed by D Code", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-pi-import-candidates-"));
  const sessionsDirectory = join(root, "sessions");
  try {
    await writeSession(sessionsDirectory, "plain-pi-session", root, false);
    await writeSession(sessionsDirectory, "managed-dcode-session", root, true);
    const candidates = await listPiImportCandidates(new SessionReader(sessionsDirectory), [], 1);
    assert.deepEqual(candidates.map((candidate) => candidate.sourceSessionId), ["plain-pi-session"]);
    assert.equal(candidates[0]?.previouslyImported, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi import preserves visible original text while marking historical lineage unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-pi-import-prepare-"));
  const sessionsDirectory = join(root, "sessions");
  try {
    await writeSession(sessionsDirectory, "plain-pi-session", root, false);
    const prepared = await preparePiSessionImport(
      new SessionReader(sessionsDirectory),
      "plain-pi-session",
      [],
    );
    assert.match(prepared.preview.sourceDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(prepared.preview.lineageStatus, "unknown");
    assert.equal(prepared.preview.omittedContent.hiddenThinking, true);
    assert.equal(prepared.preview.omittedContent.toolArguments, true);
    assert.equal(prepared.entries.length, 3);
    assert.equal(prepared.entries[0]?.messageRole, "user");
    assert.equal(prepared.entries[0]?.content, "用户提交原文，必须逐字保留。 [REDACTED]");
    assert.deepEqual(prepared.entries[1]?.content, [
      { type: "text", text: "可见回答原文。 [REDACTED]" },
      { type: "toolCallReference", id: "tool-1", name: "bash", argumentsOmitted: true },
    ]);
    const toolResult = prepared.entries[2]?.content as Array<Record<string, unknown>>;
    assert.equal(toolResult[0]?.type, "toolResultReference");
    assert.match(String(toolResult[0]?.digest), /^sha256:[a-f0-9]{64}$/);
    assert.equal(toolResult[0]?.textOmitted, true);
    assert.equal(prepared.preview.omittedContent.redactedSecrets, true);
    assert.equal(prepared.preview.omittedContent.toolResults, true);
    assert.equal(prepared.paths.length, 1);
    assert.deepEqual(prepared.paths[0]?.sourceEntryIds, [
      "plain-pi-session-user",
      "plain-pi-session-assistant",
      "plain-pi-session-tool-result",
    ]);
    assert.equal(JSON.stringify(prepared.entries).includes("hidden chain of thought"), false);
    assert.equal(JSON.stringify(prepared.entries).includes("secret"), false);
    assert.equal(JSON.stringify(prepared.entries).includes("abcdefghijklmnopqrstuvwxyz"), false);
    assert.equal(JSON.stringify(prepared.entries).includes("ghp_"), false);
    assert.equal(JSON.stringify(prepared.entries).includes("hf_"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi import refuses the explicit path for a D Code-managed source", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-pi-import-managed-"));
  const sessionsDirectory = join(root, "sessions");
  try {
    await writeSession(sessionsDirectory, "managed-dcode-session", root, true);
    await assert.rejects(
      preparePiSessionImport(new SessionReader(sessionsDirectory), "managed-dcode-session", []),
      (error: unknown) => error instanceof PiSessionImportError
        && error.code === "PI_IMPORT_SOURCE_MANAGED_BY_DCODE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi import preserves every terminal Session Path instead of only the current branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-pi-import-paths-"));
  const sessionsDirectory = join(root, "sessions");
  const directory = join(sessionsDirectory, "branched-session");
  await mkdir(directory, { recursive: true });
  const timestamp = "2026-08-25T00:00:00.000Z";
  try {
    await writeFile(join(directory, "branched-session.jsonl"), `${[
      { type: "session", version: 3, id: "branched-session", timestamp, cwd: root },
      {
        type: "message", id: "u1", parentId: null, timestamp,
        message: { role: "user", content: "branch root", timestamp: 1 },
      },
      {
        type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-25T00:00:01.000Z",
        message: { role: "assistant", content: "first branch", timestamp: 2 },
      },
      {
        type: "message", id: "a2", parentId: "u1", timestamp: "2026-08-25T00:00:02.000Z",
        message: { role: "assistant", content: "current branch", timestamp: 3 },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const prepared = await preparePiSessionImport(
      new SessionReader(sessionsDirectory),
      "branched-session",
      [],
    );
    assert.equal(prepared.entries.length, 3);
    assert.equal(prepared.paths.length, 2);
    assert.deepEqual(
      prepared.paths.map((path) => ({ leaf: path.sourceLeafEntryId, current: path.isCurrent, entries: path.sourceEntryIds })),
      [
        { leaf: "a2", current: true, entries: ["u1", "a2"] },
        { leaf: "a1", current: false, entries: ["u1", "a1"] },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
