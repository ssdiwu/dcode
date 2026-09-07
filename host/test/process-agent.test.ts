import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { ProcessAgent } from "../src/process-agent.js";

const model: Model<"openai-completions"> = {
  id: "isolated-test", name: "Isolated test", provider: "local-test", api: "openai-completions", baseUrl: "http://invalid.local",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000,
};
function message(text: string, content?: AssistantMessage["content"]): AssistantMessage {
  return { role: "assistant", content: content ?? [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
    stopReason: content?.some((item) => item.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function response(answer: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: answer });
  stream.push({ type: "done", reason: answer.stopReason as "stop" | "toolUse", message: answer });
  stream.end(answer);
  return stream;
}

test("private Pi loops use different OS processes and retain Host tool and event ownership", async () => {
  const scope = new AsyncLocalStorage<string>();
  const executions: Array<{ owner: string | undefined; pid: number; value: string }> = [];
  const events: string[] = [];
  const make = () => new ProcessAgent({ initialState: { model, tools: [{ name: "record", label: "Record", description: "Record a test value", parameters: Type.Object({ value: Type.String() }),
    execute: async (_id, args) => { executions.push({ owner: scope.getStore(), pid: process.pid, value: (args as { value: string }).value }); return { content: [{ type: "text", text: "recorded" }], details: {} }; } }] },
    idleTimeoutMs: -1,
    streamFn: (_model, context) => {
      assert.ok(scope.getStore());
      return response(context.messages.some((item) => item.role === "toolResult") ? message("complete") : message("", [{ type: "toolCall", id: "call-one", name: "record", arguments: { value: scope.getStore()! } }]));
    },
  });
  const a = make(); const b = make();
  a.beforeToolCall = async () => { assert.equal(scope.getStore(), "A"); return undefined; };
  a.subscribe(async (event) => { assert.equal(scope.getStore(), "A"); events.push(event.type); });
  try {
    await Promise.all([scope.run("A", () => a.prompt("work A")), scope.run("B", () => b.prompt("work B"))]);
    assert.ok(a.processInfo?.pid && b.processInfo?.pid);
    assert.notEqual(a.processInfo.pid, process.pid);
    assert.notEqual(a.processInfo.pid, b.processInfo.pid);
    assert.deepEqual(executions.map((item) => item.owner).sort(), ["A", "B"]);
    assert.ok(executions.every((item) => item.pid === process.pid));
    assert.ok(events.includes("tool_execution_end") && events.includes("agent_end"));
    assert.equal(a.state.messages.filter((item) => item.role === "assistant").length, 2);
    assert.equal(a.state.isStreaming, false);
  } finally { await Promise.all([a.disposeProcess(), b.disposeProcess()]); }
});

test("idle process retirement reopens a new process with the same conversation history", async () => {
  let seen = 0;
  const agent = new ProcessAgent({ initialState: { model }, idleTimeoutMs: 10, streamFn: (_model, context) => { seen = context.messages.length; return response(message("saved")); } });
  try {
    await agent.prompt("remember first");
    const first = agent.processInfo!;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(agent.processInfo?.status, "exited");
    assert.equal(agent.processInfo?.exitReason, "idle");
    await agent.prompt("continue second");
    assert.notEqual(agent.processInfo?.pid, first.pid);
    assert.notEqual(agent.processInfo?.executionId, first.executionId);
    assert.equal(seen, 3);
    assert.equal(agent.state.messages.length, 4);
  } finally { await agent.disposeProcess(); }
});

test("terminating one running process does not stop an unrelated Agent", async () => {
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const a = new ProcessAgent({ initialState: { model }, idleTimeoutMs: -1, streamFn: (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    options?.signal?.addEventListener("abort", () => { const answer = { ...message(""), stopReason: "aborted" as const }; stream.push({ type: "error", reason: "aborted", error: answer }); stream.end(answer); }, { once: true });
    signalStarted();
    return stream;
  } });
  const b = new ProcessAgent({ initialState: { model }, idleTimeoutMs: -1, streamFn: () => response(message("other continues")) });
  try {
    const pending = a.prompt("long-running work");
    const rejected = assert.rejects(pending, /process exited/);
    await Promise.race([started, pending.then(() => { throw new Error("Agent finished before requesting the model"); })]);
    process.kill(a.processInfo!.pid, "SIGTERM");
    await rejected;
    await b.prompt("independent work");
    assert.equal(b.state.messages.at(-1)?.role, "assistant");
    assert.equal(a.processInfo?.status, "exited");
    assert.equal(b.processInfo?.status, "idle");
  } finally { await Promise.all([a.disposeProcess(), b.disposeProcess()]); }
});

test("cleared idle queues do not execute and queued continuation follows an assistant response", async () => {
  const seen: string[] = [];
  const agent = new ProcessAgent({ initialState: { model }, idleTimeoutMs: -1, streamFn: (_model, context) => {
    const user = context.messages.filter((item) => item.role === "user").at(-1);
    const text = user && Array.isArray(user.content) ? user.content.filter((item) => item.type === "text").map((item) => item.text).join("") : "";
    seen.push(text);
    return response(message("done"));
  } });
  const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() });
  try {
    agent.followUp(user("CANCELLED FOLLOWUP"));
    agent.steer(user("CANCELLED STEER"));
    agent.clearFollowUpQueue();
    assert.equal(agent.hasQueuedMessages(), true);
    agent.clearSteeringQueue();
    assert.equal(agent.hasQueuedMessages(), false);
    await agent.prompt("live");
    agent.followUp(user("queued continuation"));
    await agent.continue();
    assert.deepEqual(seen, ["live", "queued continuation"]);
    assert.equal(agent.hasQueuedMessages(), false);
    assert.equal(agent.state.messages.at(-1)?.role, "assistant");
  } finally { await agent.disposeProcess(); }
});

test("a prompt arriving during idle retirement waits for the old process to exit", async () => {
  const agent = new ProcessAgent({ initialState: { model }, idleTimeoutMs: -1, streamFn: () => response(message("done")) });
  try {
    await agent.prompt("first");
    const first = agent.processInfo!.pid;
    const retirement = agent.retireIfIdle();
    await agent.prompt("arrived during retirement");
    await retirement;
    assert.notEqual(agent.processInfo!.pid, first);
    assert.equal(agent.state.messages.length, 4);
    assert.equal(agent.processInfo!.status, "idle");
  } finally { await agent.disposeProcess(); }
});

test("process shutdown joins durable exit observation before returning",async()=>{
  let exitRecorded=false;
  const agent=new ProcessAgent({initialState:{model},idleTimeoutMs:-1,streamFn:()=>response(message("done")),onProcessChanged:async info=>{if(info.status==="exited"){await new Promise(resolve=>setTimeout(resolve,20));exitRecorded=true;}}});
  await agent.prompt("work");await agent.disposeProcess();assert.equal(exitRecorded,true);
});

test("failed process persistence prevents inference and a later observed run can recover",async()=>{
  let fail=true,calls=0;
  const agent=new ProcessAgent({initialState:{model},idleTimeoutMs:-1,streamFn:()=>{calls++;return response(message("done"));},onProcessChanged:async info=>{if(info.status==="running"&&fail){fail=false;throw new Error("fixture persistence unavailable");}}});
  try{await assert.rejects(agent.prompt("not executed"),/persistence unavailable/);assert.equal(calls,0);await agent.prompt("retry after recovery");assert.equal(calls,1);}finally{await agent.disposeProcess();}
});


test('a ready process that never accepts its run is stopped before occupancy is released',async()=>{
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {pathToFileURL}=await import('node:url');
  const root=await mkdtemp(join(tmpdir(),'dcode-unresponsive-agent-')),entry=join(root,'ready-only.mjs');
  await writeFile(entry,`process.on('message',()=>{});process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),80));process.send({kind:'ready',pid:process.pid});setInterval(()=>{},1000);`);
  const states:Array<{pid:number;status:string}>=[];let calls=0;
  const stuck=new ProcessAgent({initialState:{model},processEntry:pathToFileURL(entry),runAcceptTimeoutMs:60,idleTimeoutMs:-1,streamFn:()=>{calls++;return response(message('must not run'));},onProcessChanged:info=>{states.push(info);}});
  const other=new ProcessAgent({initialState:{model},idleTimeoutMs:-1,streamFn:()=>response(message('other continues'))});
  try{
    const pending=stuck.prompt('unresponsive start');let settled=false;const rejected=assert.rejects(pending,/未能接收/).then(()=>{settled=true;});
    while(!states.some(info=>info.status==='starting'))await new Promise(resolve=>setTimeout(resolve,5));
    const pid=stuck.processInfo!.pid;process.kill(pid,0);assert.equal(stuck.state.isStreaming,true);assert.ok(!states.some(info=>info.status==='running'));
    await assert.rejects(stuck.prompt('must wait'),/already processing/);
    await new Promise(resolve=>setTimeout(resolve,75));assert.equal(settled,false,'timeout requests termination but waits for actual exit');process.kill(pid,0);
    await other.prompt('independent');await rejected;
    assert.equal(calls,0);assert.equal(stuck.processInfo!.status,'exited');assert.equal(stuck.processInfo!.exitReason,'start_failed');assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.equal(other.state.messages.at(-1)?.role,'assistant');
  }finally{await Promise.all([stuck.disposeProcess(),other.disposeProcess()]);await rm(root,{recursive:true,force:true});}
});
