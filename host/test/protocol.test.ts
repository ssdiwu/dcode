import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_METHODS,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  errorResponse,
  isHostMethod,
  parseRequest,
  protocolEvent,
  successResponse,
  validateMethodParams,
} from "../src/protocol.js";

test("parseRequest accepts a valid envelope", () => {
  const request = parseRequest({
    version: PROTOCOL_VERSION,
    type: "request",
    id: "r1",
    method: "host.hello",
    params: {},
  });
  assert.equal(request.id, "r1");
  assert.equal(request.method, "host.hello");
});

test("parseRequest rejects an unsupported version", () => {
  assert.throws(
    () => parseRequest({ version: 2, type: "request", id: "r1", method: "host.hello" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "UNSUPPORTED_VERSION",
  );
});

test("parseRequest bounds correlation fields", () => {
  assert.throws(
    () => parseRequest({ version: 1, type: "request", id: "x".repeat(129), method: "host.hello" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_REQUEST",
  );
  assert.throws(
    () => parseRequest({ version: 1, type: "request", id: "r1", method: "x".repeat(129) }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_REQUEST",
  );
});

test("method parameter validation rejects invalid values", () => {
  assert.doesNotThrow(() => validateMethodParams("foundation.snapshot", { afterEventSequence: 0 }));
  assert.doesNotThrow(() => validateMethodParams("taskWorkbenchViewState.patch", {
    requestId: "workbench-selection",
    expectedStoreRevision: 4,
    expectedViewStateRevision: 1,
    patch: {
      selection: { taskId: "task-a", sessionId: "session-a" },
    },
  }));
  assert.doesNotThrow(() => validateMethodParams("dcodeSession.composerDraft.set", {
    requestId: "save-composer-draft",
    expectedStoreRevision: 4,
    taskId: "task-a",
    dcodeSessionId: "session-a",
    text: "未提交草稿",
  }));
  assert.throws(
    () => validateMethodParams("taskWorkbenchViewState.patch", {
      requestId: "bad-workbench-selection",
      expectedStoreRevision: 4,
      expectedViewStateRevision: 1,
      patch: { selection: { taskId: "task-a", sessionId: null } },
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("project.create", {
    requestId: "project-request",
    expectedStoreRevision: 0,
    title: "D Code",
    directory: "/work/dcode",
  }));
  assert.doesNotThrow(() => validateMethodParams("task.create", {
    requestId: "task-request",
    expectedStoreRevision: 0,
    scope: { kind: "user", userId: "current-user" },
    title: "Native task",
    goal: "Create the native Task bundle",
    acceptance: ["Task exists"],
  }));
  const taskContextReplace = {
    requestId: "task-context-replace",
    expectedStoreRevision: 2,
    scope: { kind: "project", projectId: "project-a" },
    taskId: "task-a",
    expectedContextRevision: 1,
    sources: [
      { kind: "scope_document", relativePath: "DESIGN.md", title: "设计" },
      { kind: "global_knowledge", rootPath: "/Users/tester/Workspace/Write/Content", relativePath: "context.md" },
    ],
  };
  assert.doesNotThrow(() => validateMethodParams("task.context.replace", taskContextReplace));
  assert.throws(
    () => validateMethodParams("task.context.replace", {
      ...taskContextReplace,
      sources: [{ kind: "global_knowledge", rootPath: "/Users/tester/Knowledge", relativePath: "a.md", extra: true }],
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  const taskPlanCreate = {
    requestId: "task-plan-create",
    expectedStoreRevision: 3,
    scope: { kind: "project", projectId: "project-a" },
    taskId: "task-a",
    state: "active",
    document: { version: 1, title: "Plan" },
  };
  assert.doesNotThrow(() => validateMethodParams("task.plan.create", taskPlanCreate));
  assert.doesNotThrow(() => validateMethodParams("task.workItem.create", {
    requestId: "task-work-create",
    expectedStoreRevision: 4,
    scope: { kind: "project", projectId: "project-a" },
    taskId: "task-a",
    title: "Implement",
    state: "pending",
    details: { dependsOn: [] },
  }));
  assert.doesNotThrow(() => validateMethodParams("task.workItem.reorder", {
    requestId: "task-work-reorder",
    expectedStoreRevision: 5,
    scope: { kind: "project", projectId: "project-a" },
    taskId: "task-a",
    items: [{ id: "work-a", expectedRevision: 1 }],
  }));
  assert.throws(
    () => validateMethodParams("task.workItem.update", {
      requestId: "task-work-empty-update",
      expectedStoreRevision: 5,
      scope: { kind: "project", projectId: "project-a" },
      taskId: "task-a",
      workItemId: "work-a",
      expectedWorkItemRevision: 1,
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("task.create", {
      requestId: "mixed-scope",
      expectedStoreRevision: 0,
      scope: { kind: "user", userId: "current-user", projectId: "project-a" },
      title: "Invalid",
      goal: "Must fail",
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("agentRun.stop", {
    requestId: "stop-agent",
    expectedStoreRevision: 9,
    runtimeId: "runtime-agent",
    scope: { kind: "project", projectId: "project-a" },
    taskId: "task-a",
    teamRunId: "team-a",
    agentRunId: "agent-a",
    sessionRunId: "session-run-a",
    expectedAgentRunRevision: 2,
  }));
  assert.doesNotThrow(() => validateMethodParams("agentRun.stop", {
    requestId: "stop-standalone-coordinator",
    expectedStoreRevision: 9,
    runtimeId: "runtime-coordinator",
    scope: { kind: "user", userId: "current-user" },
    taskId: "task-a",
    agentRunId: "coordinator-a",
    sessionRunId: "session-run-a",
    expectedAgentRunRevision: 2,
  }));
  assert.throws(
    () => validateMethodParams("task.create", {
      requestId: "null-project",
      expectedStoreRevision: 0,
      scope: { kind: "project", projectId: null },
      title: "Invalid",
      goal: "Must fail",
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("task.create", {
      requestId: "extra-scope-field",
      expectedStoreRevision: 0,
      scope: { kind: "user", userId: "current-user", unexpected: "must-not-pass" },
      title: "Invalid",
      goal: "Must fail",
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("agentProfile.update", {
    requestId: "profile-request",
    expectedStoreRevision: 0,
    profileId: "builtin-coordinator",
    expectedProfileRevision: 1,
    name: "Coordinator",
    roleContract: "Coordinate the Task",
    enabled: true,
  }));
  assert.doesNotThrow(() => validateMethodParams("agentProfile.create", {
    requestId: "create-profile",
    expectedStoreRevision: 0,
    name: "Researcher",
    roleContract: "Research a bounded question.",
    enabled: true,
  }));
  const teamStart = {
    requestId: "team-start-request",
    expectedStoreRevision: 4,
    expectedTeamRunRevision: 1,
    scope: { kind: "project", projectId: "project-a" },
    taskId: "task-a",
    teamRunId: "team-a",
    message: "Coordinate this Task",
  };
  assert.doesNotThrow(() => validateMethodParams("team.start", teamStart));
  assert.throws(
    () => validateMethodParams("team.start", {
      ...teamStart,
      workspace: { workspaceId: "caller-controlled", cwd: "/work/project", access: "sharedReadOnly" },
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("team.start", { ...teamStart, expectedTeamRunRevision: undefined }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  const agentRequestAnswer = {
    requestId: "answer-request",
    expectedStoreRevision: 8,
    runtimeId: "runtime-agent",
    scope: { kind: "project", projectId: "project-a" },
    taskId: "task-a",
    teamRunId: "team-a",
    agentRunId: "agent-a",
    sessionRunId: "session-run-a",
    agentRequestId: "request-a",
    expectedRequestRevision: 1,
    answer: { kind: "choice", optionId: "recommended" },
  };
  assert.doesNotThrow(() => validateMethodParams("agentRequest.answer", agentRequestAnswer));
  assert.throws(
    () => validateMethodParams("agentRequest.answer", {
      ...agentRequestAnswer,
      runtimeId: undefined,
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("agentRequest.answer", {
      ...agentRequestAnswer,
      answer: { kind: "text", value: "unstructured" },
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("piImport.listCandidates", { limit: 50 }));
  assert.doesNotThrow(() => validateMethodParams("piImport.preview", { sourceSessionId: "pi-session" }));
  assert.doesNotThrow(() => validateMethodParams("piImport.importAsTask", {
    requestId: "import-request",
    expectedStoreRevision: 0,
    scope: { kind: "project", projectId: "project-a" },
    sourceSessionId: "pi-session",
  }));
  assert.doesNotThrow(() => validateMethodParams("session.importedEntries", { sessionId: "dcode-session" }));
  assert.throws(
    () => validateMethodParams("session.open", { sessionId: "s1", mode: "write" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("session.open", { sessionId: "s1", mode: "writable" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams(
    "session.open",
    { sessionId: "s1", mode: "writable", writeIntent: true },
  ));
  assert.doesNotThrow(() => validateMethodParams("session.open", {
    sessionId: "adapter-session",
    adapterSessionId: "adapter-session",
    runtimeId: "runtime-one",
    taskId: "task-one",
    dcodeSessionId: "dcode-session-one",
    scope: { kind: "project", projectId: "project-one" },
    workspace: { workspaceId: "workspace-one", cwd: "/work/one", access: "exclusiveWrite" },
    mode: "writable",
    writeIntent: true,
  }));
  assert.doesNotThrow(() => validateMethodParams("runtime.start", {
    requestId: "start-runtime",
    runtimeId: "runtime-one",
    taskId: "task-one",
    dcodeSessionId: "dcode-session-one",
    scope: { kind: "project", projectId: "project-one" },
    workspace: { workspaceId: "workspace-one", cwd: "/work/one", access: "exclusiveWrite" },
  }));
  assert.throws(
    () => validateMethodParams("session.open", {
      sessionId: "adapter-session",
      adapterSessionId: "another-session",
      runtimeId: "runtime-one",
      taskId: "task-one",
      dcodeSessionId: "dcode-session-one",
      scope: { kind: "project", projectId: "project-one" },
      workspace: { workspaceId: "workspace-one", cwd: "/work/one", access: "exclusiveWrite" },
      mode: "writable",
      writeIntent: true,
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("session.open", { sessionId: "s1", mode: "readOnly" }));
  assert.doesNotThrow(() => validateMethodParams("session.close", { expectedSessionId: "s1" }));
  assert.throws(
    () => validateMethodParams("session.close", { expectedSessionId: "" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("session.create", { cwd: "" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("session.relocateCwd", {
    sourceCwd: "/work/old",
    targetCwd: "/work/new",
    moveFiles: false,
  }));
  assert.throws(
    () => validateMethodParams("session.relocateCwd", {
      sourceCwd: "/work/old",
      targetCwd: "/work/new",
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("session.getModels", {}));
  assert.doesNotThrow(() => validateMethodParams("session.getModels", { cwd: "/work" }));
  assert.throws(
    () => validateMethodParams("session.getModels", { cwd: "" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("session.getModels", { cwd: 42 }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("modelSettings.get", { cwd: "/work" }));
  assert.doesNotThrow(() => validateMethodParams("modelSettings.refresh", { cwd: "/work" }));
  assert.doesNotThrow(() => validateMethodParams("modelSettings.setEnabledModels", {
    cwd: "/work",
    enabledModels: ["openai/gpt-*", "anthropic/claude:high"],
  }));
  assert.doesNotThrow(() => validateMethodParams("modelSettings.setEnabledModels", {
    cwd: "/work",
    enabledModels: [],
  }));
  assert.doesNotThrow(() => validateMethodParams("modelSettings.setDefaultModel", {
    cwd: "/work",
    provider: "openai",
    modelId: "gpt-5.5",
  }));
  assert.throws(
    () => validateMethodParams("modelSettings.setDefaultModel", {
      cwd: "/work",
      provider: "x".repeat(513),
      modelId: "gpt-5.5",
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("modelSettings.setDefaultModel", {
      cwd: "/work",
      provider: "openai",
      modelId: "x".repeat(513),
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("modelSettings.setEnabledModels", { cwd: "/work", enabledModels: ["  "] }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("modelSettings.setDefaultModel", { cwd: "/work", provider: "openai" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("content.renderMermaid", { source: "x".repeat(100_001) }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("session.list", {
    limit: 11,
    origin: "dcode",
    cwdScope: { match: "exact", paths: ["/work/a", "/work/b"] },
    excludedSessionIds: ["archived-a", "archived-b"],
  }));
  assert.doesNotThrow(() => validateMethodParams("session.list", {
    sessionIds: ["session-a", "session-b"],
    excludedSessionIds: ["session-b"],
  }));
  assert.throws(
    () => validateMethodParams("session.list", { origin: "pi" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("session.list", { cwdScope: { match: "parent", paths: ["/work"] } }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("session.list", { cwdScope: { match: "exact", paths: [] } }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("session.setFastMode", { enabled: true }));
  assert.throws(
    () => validateMethodParams("session.setFastMode", { enabled: "yes" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("session.setName", { name: "新的会话名称" }));
  assert.doesNotThrow(() => validateMethodParams("session.setName", { name: "" }));
  assert.throws(
    () => validateMethodParams("session.setName", { name: "第一行\n第二行" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("session.setName", { name: "x".repeat(201) }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("session.prompt", { message: "hello", promptId: "prompt-1" }));
  assert.doesNotThrow(() => validateMethodParams("session.steer", {
    message: "change direction",
    steerId: "steer-1",
    expectedRunId: "run-active",
  }));
  assert.throws(
    () => validateMethodParams("session.steer", {
      message: " /dangerous-command",
      steerId: "steer-command",
      expectedRunId: "run-active",
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("session.steer", {
      message: "missing run identity",
      steerId: "steer-missing-run",
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("modelAuth.start", {
    cwd: "/work",
    flowId: "auth-1",
    provider: "openai",
    authType: "api_key",
  }));
  assert.doesNotThrow(() => validateMethodParams("modelAuth.respond", {
    flowId: "auth-1",
    requestId: "request-1",
    value: "secret-value",
  }));
  assert.doesNotThrow(() => validateMethodParams("modelAuth.cancel", { flowId: "auth-1" }));
  assert.doesNotThrow(() => validateMethodParams("session.prompt", {
    message: "rewrite",
    promptId: "prompt-path",
    pathAction: { kind: "editUser", entryId: "user-old" },
  }));
  assert.throws(
    () => validateMethodParams("session.prompt", {
      message: " \n ",
      promptId: "prompt-empty-path",
      pathAction: { kind: "continuePath", entryId: "assistant-old" },
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("session.prompt", {
      message: "hello",
      promptId: "prompt-invalid-path",
      pathAction: { kind: "move", entryId: "assistant-old" },
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("session.prompt", { message: "hello" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("session.prompt", {
      message: "hello",
      promptId: "prompt-queued",
      streamingBehavior: "followUp",
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("session.prompt", {
    message: "look at this",
    promptId: "prompt-image",
    images: [{ type: "image", data: "aGlzdG9ncmFt", mimeType: "image/png" }],
  }));
  assert.doesNotThrow(() => validateMethodParams("session.steer", {
    message: "and this one",
    steerId: "steer-image",
    expectedRunId: "run-active",
    images: [{ type: "image", data: "aGlzdG9ncmFt", mimeType: "image/png" }],
  }));
  for (const badImages of [
    [],
    [{ type: "image", data: "aGVsbG8=", mimeType: "text/plain" }],
    [{ type: "file", data: "aGVsbG8=", mimeType: "image/png" }],
    [{ type: "image", data: "", mimeType: "image/png" }],
    [{ type: "image", data: "aGVsbG8=" }],
    Array.from({ length: 9 }, () => ({ type: "image", data: "aGVsbG8=", mimeType: "image/png" })),
    "not-an-array",
  ]) {
    assert.throws(
      () => validateMethodParams("session.prompt", {
        message: "bad images",
        promptId: "prompt-bad-images",
        images: badImages,
      }),
      (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
      `images=${JSON.stringify(badImages).slice(0, 40)} 应被拒绝`,
    );
  }
  assert.throws(
    () => validateMethodParams("session.steer", {
      message: "bad steer images",
      steerId: "steer-bad-images",
      expectedRunId: "run-active",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "application/pdf" }],
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.equal(isHostMethod("extension.customInput"), false);
  assert.equal(isHostMethod("extension.customResize"), false);
  assert.equal(HOST_METHODS.includes("extension.respond"), true);
  assert.equal(HOST_METHODS.includes("session.setFastMode"), true);
  assert.equal(HOST_METHODS.includes("session.setName"), true);
  assert.equal(isHostMethod("session.refresh"), true);
  assert.doesNotThrow(() => validateMethodParams("session.refresh", {}));
  assert.doesNotThrow(() => validateMethodParams("session.search", {
    query: "项目",
    requestToken: "search-1",
    limit: 50,
    projectSourceFolders: ["/work/a", "/work/b"],
    filterSourceFolders: ["/work/a"],
    refresh: true,
    probe: true,
  }));
  assert.throws(
    () => validateMethodParams("session.search", {
      query: "项目",
      requestToken: "search-2",
      projectSourceFolders: ["/work/a"],
      filterSourceFolders: ["/work/b"],
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("session.search", {
      query: "",
      requestToken: "search-probe",
      projectSourceFolders: [],
      probe: "yes",
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("session.open", {
    sessionId: "s1",
    mode: "readOnly",
    pathId: "leaf:assistant-old",
    expectedEntryId: "entry-1",
    expectedEntryDigest: `v1:${"a".repeat(64)}`,
    preserveActive: true,
  }));
  assert.throws(
    () => validateMethodParams("session.open", {
      sessionId: "s1",
      mode: "readOnly",
      expectedEntryDigest: `v1:${"a".repeat(64)}`,
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("session.open", {
      sessionId: "s1",
      mode: "readOnly",
      expectedEntryId: "entry-1",
      expectedEntryDigest: "sha256:not-valid",
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("session.open", {
      sessionId: "s1",
      mode: "writable",
      writeIntent: true,
      expectedEntryId: "entry-1",
      expectedEntryDigest: `v1:${"a".repeat(64)}`,
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => validateMethodParams("session.open", {
      sessionId: "s1",
      mode: "readOnly",
      preserveActive: "yes",
    }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.equal(isHostMethod("session.search"), true);
  assert.equal(isHostMethod("session.copy"), true);
  assert.equal(isHostMethod("session.trash"), true);
  assert.doesNotThrow(() => validateMethodParams("session.copy", {
    sessionId: "session-source",
    targetCwd: "/work/target",
  }));
  assert.throws(
    () => validateMethodParams("session.copy", { sessionId: "session-source", targetCwd: "" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
  assert.doesNotThrow(() => validateMethodParams("session.trash", { sessionId: "session-source" }));
  assert.throws(
    () => validateMethodParams("session.trash", { sessionId: "" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "INVALID_PARAMS",
  );
});

test("response and event constructors retain protocol correlation", () => {
  assert.deepEqual(successResponse("r1", "host.hello", { ready: true }), {
    version: 1,
    type: "response",
    id: "r1",
    method: "host.hello",
    ok: true,
    result: { ready: true },
  });
  assert.deepEqual(errorResponse("r2", "missing", "METHOD_NOT_FOUND", "unknown"), {
    version: 1,
    type: "response",
    id: "r2",
    method: "missing",
    ok: false,
    error: { code: "METHOD_NOT_FOUND", message: "unknown" },
  });
  assert.deepEqual(protocolEvent("host.ready", { version: 1 }), {
    version: 1,
    type: "event",
    event: "host.ready",
    data: { version: 1 },
  });
});
