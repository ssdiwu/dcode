import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductStore, type AgentRunRecord } from "../../src/product-store.js";
import type { RouteOperation } from "../../src/task-routes.js";

export async function routeFixture() {
  const root = await mkdtemp(join(tmpdir(), "dcode-task-routes-")), home = join(root, "home");
  await mkdir(home);
  const options = { dataRoot: join(root, ".dcode"), userHome: home };
  let store = await ProductStore.open(options), serial = 0;
  const initial = await store.snapshot(), scope = { kind: "user" as const, userId: initial.currentUser.id };
  const { task } = await store.createTask({ requestId: "task", expectedStoreRevision: initial.storeRevision, scope, title: "路线验证", goal: "降低内存并保持输出" });
  const { agentRun: owner } = await store.ensureCoordinatorAgentRun({ requestId: "owner", taskId: task.id, scope });
  const team = await store.createTeamRun({ requestId: "team", taskId: task.id, scope, coordinatorAgentRunId: owner.id,
    members: [{ profileId: "builtin-explore", title: "独立检查", taskPacket: {} }] });
  const reviewer = team.childAgentRuns[0]!;
  async function start(agent: AgentRunRecord) {
    let collaborationMessageId: string | undefined;
    if (agent.role !== "coordinator") {
      const queued = await store.queueCollaborationMessage({ requestId: `input-${++serial}`, taskId: task.id, sourceSessionId: owner.sessionId, targetAgentRunId: agent.id, author: "coordinator", originRawInputId: store.latestRouteInput(task.id)!.id, text: "核查当前路线" });
      collaborationMessageId = (await store.transitionCollaborationMessage({ requestId: `deliver-${++serial}`, id: queued.message.id, expectedRevision: queued.message.revision, state: "delivering" })).message.id;
    }
    const prepared = await store.prepareSessionRun({ requestId: `start-${++serial}`, taskId: task.id, scope, sessionId: agent.sessionId,
      ...(collaborationMessageId ? { collaborationMessageId } : {}),
      runtimeId: `runtime-${agent.id}`, agentRunId: agent.id, workspaceId: `workspace-${agent.id}`, cwd: home, workspaceAccess: "sharedReadOnly",
      message: "核查当前路线", attachmentRefs: [], roleRevision: "route-test:v1", contextRevision: 1, profileSnapshot: { role: agent.role },
      tools: [{ name: "read", description: "Read fixture", parameters: { type: "object" } }], toolsWritable: false,
      systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [] });
    await store.startSessionRun(prepared.sessionRunId); return prepared;
  }
  const ownerRun = await start(owner), reviewerRun = await start(reviewer);
  const act = (operation: RouteOperation, actor = owner, run = ownerRun, expectedPlanRevision = store.taskRouteContext(task.id)?.planRevision ?? 0, requestId = `route-${++serial}`) =>
    store.updateTaskRoute({ requestId, taskId: task.id, agentRunId: actor.id, sessionRunId: run.sessionRunId, expectedPlanRevision, operation });
  async function evidence(agent = reviewer, run = reviewerRun, toolName = "read", outcome: "succeeded" | "failed" = "succeeded") {
    const attempt = await store.prepareToolAttempt({ taskId: task.id, sessionId: agent.sessionId, sessionRunId: run.sessionRunId, toolCallId: `read-${++serial}`, toolName, parameterDigest: `sha256:${"1".repeat(64)}` });
    await store.finishOperationAttempt({ attemptId: attempt.attemptId, outcome, resultDigest: `sha256:${"2".repeat(64)}` });
    return (await store.recordToolEvidence({ requestId: `evidence-${++serial}`, attemptId: attempt.attemptId, toolName, outcome, resultDigest: `sha256:${"2".repeat(64)}` })).evidence.id;
  }
  return { get store() { return store; }, task, scope, owner, ownerRun, reviewer, reviewerRun, act, evidence, start,
    async reopenStore() { await store.close(); store = await ProductStore.open(options); },
    async close() { await store.close(); await rm(root, { recursive: true, force: true }); } };
}
