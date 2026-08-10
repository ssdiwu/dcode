import assert from "node:assert/strict";
import test from "node:test";
import { PiHost } from "../src/pi-host.js";

test("native mermaid renderer returns styled unicode art", async () => {
  const host = new PiHost({ agentDir: "/tmp/pi-dcode-mermaid-test", emit: () => undefined });
  const result = await host.handle("content.renderMermaid", {
    source: "flowchart LR\n  A[Start] --> B[Done]",
  }) as {
    rendered: boolean;
    kind: string;
    width: number;
    lines: string[];
    styled: Array<Array<{ text: string; cls: string }>>;
    warnings: string[];
  };
  assert.equal(result.rendered, true);
  assert.equal(result.kind, "flowchart");
  assert.ok(result.width > 0);
  assert.ok(result.lines.join("\n").includes("Start"));
  assert.equal(result.styled.length, result.lines.length);
  assert.deepEqual(result.warnings, []);
});

test("native mermaid renderer returns an explicit fallback", async () => {
  const host = new PiHost({ agentDir: "/tmp/pi-dcode-mermaid-test", emit: () => undefined });
  const result = await host.handle("content.renderMermaid", {
    source: "pie\n  title Pets\n  \"Dogs\" : 4",
  }) as { rendered: boolean; kind: string | null; error: string };
  assert.equal(result.rendered, false);
  assert.equal(result.kind, null);
  assert.match(result.error, /not supported/i);
});
