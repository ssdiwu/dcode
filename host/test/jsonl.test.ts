import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { JsonlDecoder, JsonlWriter } from "../src/jsonl.js";

test("decoder handles fragmented and coalesced JSONL", () => {
  const decoder = new JsonlDecoder();
  assert.deepEqual(decoder.push(Buffer.from('{"a":')) , []);
  assert.deepEqual(decoder.push(Buffer.from('1}\n{"b":2}\n')), [
    { ok: true, value: { a: 1 } },
    { ok: true, value: { b: 2 } },
  ]);
});

test("decoder reports bad JSON and continues", () => {
  const decoder = new JsonlDecoder();
  const results = decoder.push(Buffer.from('{bad}\n{"ok":true}\n'));
  assert.equal(results.length, 2);
  assert.deepEqual(results[0]?.ok, false);
  assert.deepEqual(results[1], { ok: true, value: { ok: true } });
});

test("decoder discards an oversized line and resumes", () => {
  const decoder = new JsonlDecoder(8);
  const first = decoder.push(Buffer.from("123456789"));
  assert.deepEqual(first, [{
    ok: false,
    error: { code: "LINE_TOO_LARGE", message: "JSONL line exceeds 8 bytes" },
  }]);
  const second = decoder.push(Buffer.from('\n{"x":1}\n'));
  assert.deepEqual(second, [{ ok: true, value: { x: 1 } }]);
});

test("writer preserves line order", async () => {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const writer = new JsonlWriter(stream);
  await Promise.all([writer.write({ n: 1 }), writer.write({ n: 2 }), writer.write({ n: 3 })]);
  await writer.flush();
  assert.equal(output, '{"n":1}\n{"n":2}\n{"n":3}\n');
});

test("writer rejects instead of hanging when the output stream fails", async () => {
  const stream = new Writable({
    write(_chunk, _encoding, callback) { callback(new Error("output failed")); },
  });
  const writer = new JsonlWriter(stream);
  await assert.rejects(writer.write({ n: 1 }), /output failed/);
  await assert.rejects(writer.flush(), /output failed/);
});
