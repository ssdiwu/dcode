import { defineDoc } from '@earendil-works/pi-durable';
import type { Context, JsonValue } from '@earendil-works/chord';
import type { TaskRuntime, TaskId, ToolExecutionApi, ToolExecutionResult, ToolDiagnostic } from '@earendil-works/pi-durable';

const Progress = defineDoc<{ details: JsonValue }>({ kind: 'dcode.extension-progress', version: 1, scope: 'task', initial: () => ({ details: null }) });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 把公开 TaskRuntime 绑定到同一调用；内层工具的输出、差异和诊断须保留真实内容。 */
export async function taskToolApi<I, S extends { phase: string }, R, H extends object>(runtime: TaskRuntime<I, S, R, H>, callId: string, context: Context) {
  let output = ''; let truncated = false; let details: JsonValue | undefined; let ended = false;
  const diagnostics: ToolDiagnostic[] = [];
  const assertLive = () => { if (ended || runtime.signal.aborted) throw new Error('Invocation is closed'); };
  const api: ToolExecutionApi = {
    taskId: runtime.taskId, conversationId: runtime.conversationId, callId, registry: runtime.registry,
    env: await runtime.env(context), models: runtime.models, outputWindow: undefined,
    retainedOutput() { assertLive(); return { text: output, truncated }; },
    // 现有手工工具 owner 未接原生 nested/codemode 生命周期；新增 API 明确拒绝，不能绕过已验的调用与回执桥。
    async executeTool() { assertLive(); throw new Error('Native nested tool calls are not enabled for this legacy invocation'); },
    agent: runtime.agent, snapshot: runtime.snapshot, snapshotAsOf: runtime.snapshotAsOf,
    watchDoc: runtime.watchDoc, memo: runtime.memo, getTask: runtime.getTask, waitForTask: runtime.waitForTask,
    conversation: runtime.conversation,
    output(chunk) { assertLive(); const next = output + (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); truncated ||= next.length > 262144; output = next.slice(-262144); },
    diagnostic(value) { assertLive(); if (diagnostics.length >= 128) throw new Error('Diagnostic limit'); diagnostics.push(copy(value)); },
    async details(value, ownContext) { assertLive(); details = copy(value); await runtime.commit(async tx => { (await tx.doc(Progress, runtime.taskId)).details = details!; return undefined; }, ownContext); },
    commit: async (change, ownContext) => { assertLive(); let value!: Awaited<ReturnType<typeof change>>;
      await runtime.commit(async tx => { value = await change(tx); return undefined; }, ownContext); return value; },
    createTask: async (definition, input, options, ownContext) => { assertLive(); let id!: TaskId;
      await runtime.commit(async tx => { id = await tx.createTask(definition, input, options); return undefined; }, ownContext); return id as never; },
  };
  return { api, finish(result: ToolExecutionResult): ToolExecutionResult {
    ended = true;
    return { ...result, output: result.output ?? (output ? [{ type: 'text', text: output }] : []),
      ...(result.details === undefined && details !== undefined ? { details } : {}),
      ...(diagnostics.length ? { diagnostics: [...diagnostics, ...(result.diagnostics ?? [])] } : {}) };
  } };
}
