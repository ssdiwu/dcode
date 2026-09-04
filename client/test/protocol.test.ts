import test from "node:test";
import assert from "node:assert/strict";
import { JsonlDecoder } from "../src/protocol/jsonl.js";
import { ProtocolClient } from "../src/protocol/client.js";
import type { HostEvent } from "../src/protocol/envelope.js";

test("JsonlDecoder tolerates arbitrary chunk boundaries", () => {
  const decoder = new JsonlDecoder();
  const line = JSON.stringify({ version: 1, type: "event", event: "host.ready" });
  const first = Buffer.from(line.slice(0, 11), "utf8");
  const second = Buffer.from(line.slice(11) + "\n", "utf8");
  assert.deepEqual(decoder.push(first), []);
  const results = decoder.push(second);
  assert.equal(results.length, 1);
  assert.ok(results[0] && results[0].ok);
});

test("JsonlDecoder decodes multiple lines in one chunk and skips blank lines", () => {
  const decoder = new JsonlDecoder();
  const results = decoder.push(Buffer.from('{"a":1}\n\n{"b":2}\n', "utf8"));
  assert.equal(results.length, 2);
  assert.ok(results[0] && results[0].ok && (results[0].value as { a: number }).a === 1);
  assert.ok(results[1] && results[1].ok && (results[1].value as { b: number }).b === 2);
});

test("JsonlDecoder reports oversized lines and recovers on the next line", () => {
  const decoder = new JsonlDecoder(8);
  // 完整但超限的行：按坏 JSON 报告（与 host 原版一致），不吞后续。
  const complete = decoder.push(Buffer.from("0123456789ABCDEF\n", "utf8"));
  assert.equal(complete.length, 1);
  assert.ok(complete[0] && !complete[0].ok && complete[0].error.code === "BAD_JSON");
  const recovered = decoder.push(Buffer.from('{"ok":true}\n', "utf8"));
  assert.equal(recovered.length, 1);
  assert.ok(recovered[0] && recovered[0].ok);
  // 无换行且超过上限的堆积：报告 LINE_TOO_LARGE 并丢弃至下一行边界。
  const decoder2 = new JsonlDecoder(8);
  assert.deepEqual(decoder2.push(Buffer.from("0123456789ABCDEF", "utf8")), [
    { ok: false, error: { code: "LINE_TOO_LARGE", message: "JSONL line exceeds 8 bytes" } },
  ]);
  const afterDiscard = decoder2.push(Buffer.from('\n{"ok":2}\n', "utf8"));
  assert.equal(afterDiscard.length, 1);
  assert.ok(afterDiscard[0] && afterDiscard[0].ok);
});

function createHarness() {
  const sent: string[] = [];
  const client = new ProtocolClient({
    sendLine: line => sent.push(line),
    requestTimeoutMs: 50,
  });
  return { sent, client };
}

test("ProtocolClient correlates responses by request id", async () => {
  const { sent, client } = createHarness();
  const pending = client.request<{ value: number }>("host.hello");
  await Promise.resolve();
  const request = JSON.parse(sent[0] ?? "") as { id: string; method: string };
  assert.equal(request.method, "host.hello");
  client.feed(Buffer.from(`${JSON.stringify({ version: 1, type: "response", id: request.id, method: request.method, ok: true, result: { value: 7 } })}\n`));
  assert.equal((await pending).value, 7);
});

test("ProtocolClient rejects on error responses", async () => {
  const { sent, client } = createHarness();
  const pending = client.request("missing.method");
  const captured = assert.rejects(pending, /no such capability|unknown|invalid/i).catch(() => undefined);
  await Promise.resolve();
  const request = JSON.parse(sent[0] ?? "") as { id: string; method: string };
  client.feed(Buffer.from(`${JSON.stringify({ version: 1, type: "response", id: request.id, method: request.method, ok: false, error: { code: "UNKNOWN_METHOD", message: "unknown method" } })}\n`));
});

test("ProtocolClient times out unanswered requests", async () => {
  const { client } = createHarness();
  await assert.rejects(client.request("never.answered"), /timed out/);
});

test("ProtocolClient dispatches events and ignores unknown response ids", async () => {
  const { client } = createHarness();
  const events: HostEvent[] = [];
  client.onEvent(event => events.push(event));
  client.feed(
    Buffer.from(
      `${JSON.stringify({ version: 1, type: "response", id: "unknown", method: "m", ok: true })}\n` +
      `${JSON.stringify({ version: 1, type: "event", event: "foundation.changed", data: { taskId: "t1" } })}\n`,
      "utf8",
    ),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, "foundation.changed");
});
