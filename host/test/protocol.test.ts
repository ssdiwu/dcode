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
