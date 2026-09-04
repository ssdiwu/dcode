import assert from "node:assert/strict";
import test from "node:test";
import {
  DCODE_AGENT_REQUEST_TOOL_NAME,
  DCODE_TASK_ACCEPTANCE_TOOL_NAME,
  DCodeAgentRequestController,
  createDCodeAgentRequestExtension,
} from "../src/agent-request-extension.js";

test("dcode_request remains pending until its durable Agent Request is answered", async () => {
  const controller = new DCodeAgentRequestController();
  let resolveAnswer: ((value: { requestId: string; answer: unknown }) => void) | undefined;
  controller.bind(async () => await new Promise((resolve) => { resolveAnswer = resolve; }));
  let tool: {
    name: string;
    execute: (toolCallId: string, input: unknown, signal?: AbortSignal) => Promise<{
      content: Array<{ type: string; text: string }>;
      details: { requestId: string; answer: unknown };
    }>;
  } | undefined;
  const extension = createDCodeAgentRequestExtension(controller);
  extension({
    registerTool(candidate: unknown) { tool = candidate as typeof tool; },
  } as never);
  assert.equal(tool?.name, DCODE_AGENT_REQUEST_TOOL_NAME);
  let settled = false;
  const execution = tool!.execute("tool-call-one", {
    prompt: "Choose a boundary",
    options: [
      { id: "bounded", label: "Bounded", recommended: true },
      { id: "broad", label: "Broad" },
    ],
  }).finally(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  resolveAnswer?.({ requestId: "agent-request-one", answer: { kind: "choice", optionId: "bounded" } });
  const result = await execution;
  assert.equal(result.details.requestId, "agent-request-one");
  assert.deepEqual(result.details.answer, { kind: "choice", optionId: "bounded" });
  assert.match(result.content[0]?.text ?? "", /agent-request-one/);
});

test("Coordinator-only task acceptance tool remains pending until one bound response", async () => {
  const controller = new DCodeAgentRequestController();
  let received: unknown;
  let resolveAnswer: ((value: { requestId: string; answer: unknown }) => void) | undefined;
  controller.bind(async (_toolCallId, input) => {
    received = input;
    return await new Promise((resolve) => { resolveAnswer = resolve; });
  });
  const tools: Array<{
    name: string;
    execute: (toolCallId: string, input: unknown, signal?: AbortSignal) => Promise<{
      details: { requestId: string; answer: unknown };
    }>;
  }> = [];
  const extension = createDCodeAgentRequestExtension(controller, { allowTaskAcceptance: true });
  extension({
    registerTool(candidate: unknown) { tools.push(candidate as typeof tools[number]); },
  } as never);
  assert.deepEqual(tools.map((tool) => tool.name), [
    DCODE_AGENT_REQUEST_TOOL_NAME,
    DCODE_TASK_ACCEPTANCE_TOOL_NAME,
  ]);
  const tool = tools.find((candidate) => candidate.name === DCODE_TASK_ACCEPTANCE_TOOL_NAME);
  assert.ok(tool);
  let settled = false;
  const execution = tool.execute("acceptance-tool-call", { prompt: "请验收当前 Task" })
    .finally(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(received, { kind: "task_acceptance", prompt: "请验收当前 Task", options: [] });
  resolveAnswer?.({
    requestId: "acceptance-request-one",
    answer: { kind: "task_acceptance", outcome: "feedback", feedback: "请补一条验证证据" },
  });
  const result = await execution;
  assert.equal(result.details.requestId, "acceptance-request-one");
  assert.deepEqual(result.details.answer, {
    kind: "task_acceptance",
    outcome: "feedback",
    feedback: "请补一条验证证据",
  });
});
