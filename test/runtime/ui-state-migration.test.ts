// C05 界面现场迁移（2026-10-11 只读复核 C31-2）：
//
// C05 之前的 `dcode-prototype-ui-v1` 里 `operationOfDraft` 的值是 `{operationId, text, mode}`
// （见 before-C 归档 src/renderer/store.ts:75），同一把键。现在读侧按 `version` 取值，
// 旧条目浅合并进来会让 `heldSend.version.text` 在**重开一条待核对的旧发送**时直接崩。
//
// 迁移必须承接原 operationId、原文、用途与 operationId↔草稿键的关联：清掉旧关联等于让那次
// 待核对的发送失去归属，只是把崩溃换成静默错认。本文件全部是纯函数，不启动窗口。

import assert from 'node:assert/strict';
import test from 'node:test';
import { referenceSetId } from '../../src/contracts/index.ts';
import { normalizeUiState, draftVersionOf } from '../../src/renderer/store.ts';

/** before-C 真实保存现场形状：一条待核对的旧发送，原文与用途都在，旧版本没有引用概念。 */
function legacySavedScene() {
  return {
    selectedSessionId: null,
    draftTaskId: "task-home-default",
    lastScene: { sessionId: null, draftTaskId: "task-home-default" },
    expandedWorkspaceIds: ["ws-home"],
    expandedTaskIds: [],
    expandedTaskId: "task-home-default",
    view: "session",
    inspector: null,
    drafts: { "draft:task-home-default": "旧版本待核对的发送" },
    draftOfOperation: { "op-legacy-1": "draft:task-home-default" },
    operationOfDraft: {
      "draft:task-home-default": { operationId: "op-legacy-1", text: "旧版本待核对的发送", mode: "steer" },
    },
    dismissedResume: [],
    unknownOps: ["op-legacy-1"],
    notice: null,
  };
}

await test('旧现场的发送身份被承接成完整草稿版本，读侧不再崩', () => {
  // 前提：旧现场确实没有 version 字段——读侧崩在这里，不是别的原因
  assert.equal((legacySavedScene() as { operationOfDraft: Record<string, { version?: unknown }> }).operationOfDraft["draft:task-home-default"].version, undefined);
  const ui = normalizeUiState(legacySavedScene());
  const held = ui.operationOfDraft["draft:task-home-default"];
  assert.ok(held, "旧关联必须保留，不能为了避开崩溃清掉");
  assert.equal(held.operationId, "op-legacy-1", "原 operationId 必须承接");
  // 读侧就是这一行：旧版本没有 version，这里若为空就是重开即崩
  assert.equal(held.version.text, "旧版本待核对的发送");
  assert.equal(held.version.mode, "steer", "原用途必须承接");
  // 旧版本没有引用概念，引用集合身份取空集；不是随便一个占位串
  assert.equal(held.version.referenceSetId, referenceSetId([]));
  assert.equal(
    ui.draftOfOperation["op-legacy-1"],
    "draft:task-home-default",
    "operationId↔草稿键的关联必须承接，否则旧发送找不到自己的草稿",
  );
  assert.deepEqual(ui.unknownOps, ["op-legacy-1"], "待核对标记属于运行事实，不在界面迁移里清掉");
});

await test('旧现场按同一版判据仍然认得出是那一版（换引用才算新的一版）', () => {
  const ui = normalizeUiState(legacySavedScene());
  const held = ui.operationOfDraft["draft:task-home-default"]!;
  const sameVersion = draftVersionOf(ui.drafts["draft:task-home-default"]!.trim(), "steer", []);
  assert.deepEqual(sameVersion, held.version, "原文与用途未变、旧版本本就无引用 ⇒ 仍是同一版");
  // 旧草稿现场里若带上了引用，那是新的一版：迁移出来的身份不得误判为同一版
  const withRefs = draftVersionOf(ui.drafts["draft:task-home-default"]!.trim(), "steer", [
    { kind: "file", locator: "r0/a.js", snapshot: { contentHash: "a".repeat(64) } },
  ] as never);
  assert.notDeepEqual(withRefs, held.version);
});

await test('当前形状的现场原样承接，不被迁移改写', () => {
  const version = draftVersionOf("新版本发送", "follow-up", [
    { kind: "skill", locator: "r0/.pi/skills/s/SKILL.md", snapshot: { contentHash: "b".repeat(64) } },
  ] as never);
  const ui = normalizeUiState({
    ...legacySavedScene(),
    drafts: { "draft:task-home-default": "新版本发送" },
    operationOfDraft: { "draft:task-home-default": { operationId: "op-new-1", version } },
    draftOfOperation: { "op-new-1": "draft:task-home-default" },
    referencesOfDraft: {
      "draft:task-home-default": [{
        refId: "skill-1", kind: "skill", label: "s", locator: "r0/.pi/skills/s/SKILL.md", sourceId: "skill:s",
        snapshot: { contentHash: "b".repeat(64), byteSize: 3, capturedAt: 1, truncated: false, content: "x" },
      }],
    },
  });
  assert.deepEqual(ui.operationOfDraft["draft:task-home-default"], { operationId: "op-new-1", version });
  assert.equal(ui.referencesOfDraft["draft:task-home-default"]?.length, 1, "当前形状的引用集合必须保留");
});

await test('无法还原身份的旧条目被丢弃，而不是造一个对不上任何发送的 operationId', () => {
  const ui = normalizeUiState({
    ...legacySavedScene(),
    operationOfDraft: {
      "draft:a": { operationId: "op-a" },
      "draft:b": { operationId: "op-b", text: 42 },
      "draft:c": "not-an-object",
      "draft:d": { text: "没有身份" },
    },
  });
  assert.deepEqual(Object.keys(ui.operationOfDraft), [], "四条都无法还原身份，一条都不能留下");
});

await test('损坏的引用集合整条丢弃，不留半截集合', () => {
  const ui = normalizeUiState({
    ...legacySavedScene(),
    referencesOfDraft: {
      good: [{
        refId: "file-1", kind: "file", label: "a.js", locator: "r0/a.js", sourceId: "workspace:ws-home",
        snapshot: { contentHash: "c".repeat(64), byteSize: 1, capturedAt: 1, truncated: false, content: "a" },
      }],
      bad: [{
        refId: "file-2", kind: "file", label: "b.js", locator: "r0/b.js", sourceId: "workspace:ws-home",
        snapshot: { contentHash: "不是哈希", byteSize: 1, capturedAt: 1, truncated: false, content: "b" },
      }],
      worse: "not-an-array",
    },
  });
  assert.equal(ui.referencesOfDraft.good?.length, 1, "合法集合保留");
  assert.equal(ui.referencesOfDraft.bad, undefined, "含非法条目的集合整条丢弃");
  assert.equal(ui.referencesOfDraft.worse, undefined, "形状不对的集合丢弃");
});

await test('损坏或缺失的整体现场回到默认形状，不阻塞启动', () => {
  for (const bad of [null, undefined, 'string', 42, []]) {
    const ui = normalizeUiState(bad);
    assert.equal(ui.selectedSessionId, null);
    assert.deepEqual(ui.operationOfDraft, {});
    assert.deepEqual(ui.drafts, {});
  }
  const partial = normalizeUiState({ drafts: { a: 1, b: "文字" }, expandedWorkspaceIds: ["x", 2], view: "settings" });
  assert.deepEqual(partial.drafts, { b: "文字" }, "非字符串草稿值被剔除");
  assert.deepEqual(partial.expandedWorkspaceIds, ["x"]);
  assert.equal(partial.view, "settings");
});
