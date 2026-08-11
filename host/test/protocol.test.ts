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
  assert.doesNotThrow(() => validateMethodParams("session.prompt", { message: "hello", promptId: "prompt-1" }));
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
  assert.equal(isHostMethod("session.refresh"), true);
  assert.doesNotThrow(() => validateMethodParams("session.refresh", {}));
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
