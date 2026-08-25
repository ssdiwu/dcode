import assert from "node:assert/strict";
import test from "node:test";
import {
  DCODE_AGENT_REQUEST_TOOL_NAME,
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
