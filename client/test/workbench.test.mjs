import { profilePresentation, thinkingLabels } from "../src/renderer/src/workbench/presentation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  messageRows,
  emptyStream,
  reduceStream,
  mutationQueue,
} from "../src/renderer/src/workbench.ts";
import { resolveClientPaths } from "../dist/src/main/paths.js";
import { validateMethodParams } from "../../host/dist/src/protocol.js";

test("real Pi tool-result text retains process ownership and images survive projection", () => {
  const rows = messageRows([
    {
      id: "u",
      type: "message",
      timestamp: "2026-09-05T00:00:00Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "check" },
          { type: "image", mimeType: "image/png", data: "AA==" },
        ],
      },
    },
    {
      id: "t",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        content: [{ type: "text", text: "tool output" }],
      },
    },
  ]);
  assert.equal(rows[0].parts[1].kind, "image");
  assert.equal(rows[1].role, "process");
  assert.equal(rows[1].parts[0].kind, "tool");
  assert.equal(rows[1].parts[0].text, "tool output");
});
test("nested streaming deltas are session scoped and retained until durable handoff", () => {
  const event = (sessionId, type, extra = {}) => ({
    version: 1,
    type: "event",
    event: "session.event",
    data: { sessionId, type, ...extra },
  });
  let state = emptyStream("a");
  const unrelated = event("b", "message_update", {
    assistantMessageEvent: { type: "text_delta", delta: "WRONG" },
  });
  assert.equal(reduceStream(state, unrelated, "a"), state);
  state = reduceStream(
    state,
    event("a", "message_update", {
      assistantMessageEvent: { type: "thinking_delta", delta: "thinking" },
    }),
    "a",
  );
  state = reduceStream(
    state,
    event("a", "message_update", {
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    }),
    "a",
  );
  state = reduceStream(
    state,
    event("a", "message_update", {
      assistantMessageEvent: { type: "text_delta", delta: " world" },
    }),
    "a",
  );
  state = reduceStream(state, event("a", "message_end"), "a");
  assert.equal(state.messages[0].text, "hello world");
  assert.equal(state.messages[0].thinking, "thinking");
  state = reduceStream(state, event("a", "agent_end"), "a");
  assert.equal(state.active, false);
  assert.equal(state.messages[0].text, "hello world");
});
test("Store writes serialize, refresh revisions, and retain a request identity on explicit conflicts", async () => {
  let revision = 1,
    calls = [],
    conflict = true;
  const client = {
    async request(method, params) {
      if (method === "foundation.snapshot")
        return {
          storeRevision: revision,
          taskWorkbenchViewState: { revision },
        };
      calls.push(params);
      if (conflict) {
        conflict = false;
        revision++;
        throw Object.assign(new Error("revision"), {
          code: "REVISION_CONFLICT",
        });
      }
      assert.equal(params.expectedStoreRevision, revision);
      revision++;
      return revision;
    },
  };
  const mutate = mutationQueue(client);
  await Promise.all([
    mutate("task.create", { title: "a" }),
    mutate("task.create", { title: "b" }),
  ]);
  assert.equal(calls[0].requestId, calls[1].requestId);
  assert.notEqual(calls[1].requestId, calls[2].requestId);
  assert.equal(revision, 4);
});
test("packaged lookup agrees with Host resource layout and original icon", () => {
  const paths = resolveClientPaths(
    "/App/Contents/Resources/app.asar/dist/src/main",
    true,
    "/App/Contents/Resources",
  );
  assert.equal(paths.host, "/App/Contents/Resources/host/dist/src/index.js");
  assert.equal(paths.icon, "/App/Contents/Resources/AppIcon.png");
});
test("client request shapes pass the actual Host validator", () => {
  validateMethodParams("session.search", {
    query: "work",
    requestToken: "search-test",
    projectSourceFolders: [],
    limit: 40,
  });
  validateMethodParams("piImport.preview", { sourceSessionId: "source" });
  validateMethodParams("piImport.importAsTask", {
    requestId: "import",
    expectedStoreRevision: 1,
    sourceSessionId: "source",
    scope: { kind: "user", userId: "user" },
  });
  validateMethodParams("dcodeSession.prompt", {
    dcodeSessionId: "session",
    promptId: "prompt",
    message: "hi",
    images: [{ type: "image", mimeType: "image/png", data: "AA==" }],
  });
  validateMethodParams("clientPreferences.set", {
    requestId: "pref",
    expectedStoreRevision: 1,
    readingPosition: { sessionId: "s", offset: 10 },
  });
});

test("an assistant error with no text remains visible", () => {
  const rows = messageRows([
    {
      id: "failed",
      type: "message",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Test provider unavailable",
      },
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].parts[0].text, "Test provider unavailable");
});


test("built-in profile labels are Chinese while custom profile content remains authored",()=>{
  const builtin={id:"builtin-coordinator",name:"Coordinator",roleContract:"Own the Task-level plan, delegate bounded work, resolve requests, and synthesize evidence. Never accept the Task on the user's behalf."};
  assert.equal(profilePresentation(builtin).name,"协调者");
  assert.match(profilePresentation(builtin).description,/由你确认/);
  assert.equal(builtin.name,"Coordinator");
  assert.deepEqual(profilePresentation({...builtin,name:"My coordinator",roleContract:"My own rules"}),{name:"My coordinator",description:"My own rules"});
  assert.equal(thinkingLabels.medium,"中等");
});


test("model presentation components do not call Host or transport APIs",async()=>{
  const {readFile}=await import("node:fs/promises");
  for(const file of ["ModelPicker.tsx","Composer.tsx"]){const source=await readFile(new URL(`../src/renderer/src/components/${file}`,import.meta.url),"utf8");assert.doesNotMatch(source,/\bapi\s*\(|\.request\s*\(|\.mutateStore\s*\(/,file);}
  const settings=await readFile(new URL("../src/renderer/src/components/SettingsWorkspace.tsx",import.meta.url),"utf8");
  const modelPage=settings.slice(settings.indexOf("function Models("),settings.indexOf("function Providers("));
  assert.doesNotMatch(modelPage,/\bapi\s*\(|\.request\s*\(|\.mutateStore\s*\(/);
});
