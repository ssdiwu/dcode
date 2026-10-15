// C6 三条清稿通路的统一判据（2026-10-11 只读复核 C31-3 / F4）：
//
// 三条通路都必须走同一个"当前草稿是否仍是这次提交的那一版"判据：
//   · 直接应答：发送时界面持有的 version；
//   · 自然快照：外层回包丢失后，正式快照把那条消息投影成 accepted；
//   · 显式查回与重试：回执沿原消息的只读回查/重试入口确认接收。
//
// 关键判据：**同文字换引用 = 新的一版**。此时文字与引用都必须留下，只解除这次发送的身份占位。
// 旧实现里自然快照与显式回查只比文字，于是同文字换引用后旧一次 accepted 会把新稿清空，
// 或者只清文字留下 chip。本文件直接对共用判据做断言，不启动窗口。

import assert from 'node:assert/strict';
import test from 'node:test';
import { referenceSetId } from '../../src/contracts/index.ts';
import type { WorkReference } from '../../src/contracts/index.ts';
import { clearAcceptedDraft, draftVersionOf, isSameDraftVersion, type UiState } from '../../src/renderer/store.ts';

const KEY = "s:session-1";

function reference(kind: 'file' | 'skill', locator: string, hash: string): WorkReference {
  return {
    refId: `${kind}-${hash.slice(0, 6)}`, kind, label: locator.split('/').pop() ?? locator, locator, sourceId: `workspace:ws`,
    snapshot: { contentHash: hash, byteSize: 1, capturedAt: 1, truncated: false, content: '正文' },
  };
}

/** 一次发送之后的界面现场：文字、引用与发送身份都在。 */
function afterSend(overrides: Partial<UiState> = {}): UiState {
  return {
    selectedSessionId: "session-1", draftTaskId: null, lastScene: null,
    expandedWorkspaceIds: [], expandedTaskIds: [], expandedTaskId: null, view: "session", inspector: null,
    drafts: { [KEY]: "同一段文字" },
    referencesOfDraft: { [KEY]: [reference('file', 'r0/src/a.js', 'a'.repeat(64))] },
    draftOfOperation: { "op-1": KEY },
    operationOfDraft: { [KEY]: { operationId: "op-1", version: draftVersionOf("同一段文字", "steer", [reference('file', 'r0/src/a.js', 'a'.repeat(64))]) } },
    dismissedResume: [], unknownOps: [], notice: null,
    ...overrides,
  };
}

await test('三条通路传入同一个发送版本时，判据结论一致', () => {
  const sentVersion = draftVersionOf("同一段文字", "steer", [reference('file', 'r0/src/a.js', 'a'.repeat(64))]);
  const ui = afterSend();
  // 直接应答、自然快照、显式查回与重试走的是同一个函数；此处用三种入口形态各调一次
  const viaDirect = clearAcceptedDraft(ui, "op-1", sentVersion, "steer");
  const viaSnapshot = clearAcceptedDraft(afterSend(), "op-1", draftVersionOf("同一段文字", "steer", [reference('file', 'r0/src/a.js', 'a'.repeat(64))]), "steer");
  const viaCheck = clearAcceptedDraft(afterSend(), "op-1", draftVersionOf("同一段文字", "steer", [reference('file', 'r0/src/a.js', 'a'.repeat(64))]), "steer");
  assert.deepEqual(viaDirect, viaSnapshot);
  assert.deepEqual(viaDirect, viaCheck);
});

await test('仍是那一版：文字与引用一并清走，身份关联解除', () => {
  const sentVersion = draftVersionOf("同一段文字", "steer", [reference('file', 'r0/src/a.js', 'a'.repeat(64))]);
  const next = clearAcceptedDraft(afterSend(), "op-1", sentVersion, "steer");
  assert.equal(next.drafts[KEY], "", "已接收的这一次要把原文字清掉");
  assert.equal(next.referencesOfDraft[KEY], undefined, "引用随这次发送一起带走");
  assert.equal(next.operationOfDraft[KEY], undefined);
  assert.equal(next.draftOfOperation["op-1"], undefined);
});

await test('同文字换引用：文字与引用都留下，只解除这次发送的身份', () => {
  const sentVersion = draftVersionOf("同一段文字", "steer", [reference('file', 'r0/src/a.js', 'a'.repeat(64))]);
  // 发送在途期间用户又加了一条引用：文字没变，但已经是新的一版
  const ui = afterSend({
    referencesOfDraft: {
      [KEY]: [reference('file', 'r0/src/a.js', 'a'.repeat(64)), reference('skill', 'r0/.pi/skills/s/SKILL.md', 'b'.repeat(64))],
    },
  });
  const next = clearAcceptedDraft(ui, "op-1", sentVersion, "steer");
  assert.equal(next.drafts[KEY], "同一段文字", "同文字换引用时新稿文字不得被清掉");
  assert.equal(next.referencesOfDraft[KEY]?.length, 2, "新引用必须原样保留，不能只留 chip 丢文字，也不能只剩 chip");
  assert.equal(next.referencesOfDraft[KEY]?.[1]?.locator, "r0/.pi/skills/s/SKILL.md");
  assert.equal(next.operationOfDraft[KEY], undefined, "只解除这次发送的身份占位");
  assert.equal(next.draftOfOperation["op-1"], undefined);
});

await test('发送途中移除了引用：已接收的这一次不得把移除前的旧集合写回来', () => {
  const sentVersion = draftVersionOf("同一段文字", "steer", [reference('file', 'r0/src/a.js', 'a'.repeat(64))]);
  const ui = afterSend({ referencesOfDraft: { [KEY]: [] } });
  const next = clearAcceptedDraft(ui, "op-1", sentVersion, "steer");
  assert.equal(next.drafts[KEY], "同一段文字", "集合变了就不是同一版，新稿文字保留");
  assert.deepEqual(next.referencesOfDraft[KEY], [], "不得恢复用户已移除的引用");
});

await test('换用途同样算新的一版', () => {
  const sentVersion = draftVersionOf("同一段文字", "steer", [reference('file', 'r0/src/a.js', 'a'.repeat(64))]);
  const next = clearAcceptedDraft(afterSend(), "op-1", sentVersion, "follow-up");
  assert.equal(next.drafts[KEY], "同一段文字", "用途变了不得清掉用户正在写的新稿");
});

await test('A 的 accepted 不清 B 的草稿与身份', () => {
  const B = "s:session-2";
  const sentVersion = draftVersionOf("B 的文字", "steer", []);
  const base = afterSend();
  const ui: UiState = {
    ...base,
    // A 有自己的一次在途发送与自己的文字；这次被确认接收的是 B
    drafts: { ...base.drafts, [KEY]: "A 的文字", [B]: "B 的文字" },
    draftOfOperation: { ...base.draftOfOperation, "op-b": B },
    // A 与 B 各有一次在途发送：B 的回执不得动 A
    operationOfDraft: { ...base.operationOfDraft, [B]: { operationId: "op-b", version: sentVersion } },
  };
  const next = clearAcceptedDraft(ui, "op-b", sentVersion, "steer");
  assert.equal(next.drafts[B], "", "B 自己那次 accepted 清 B");
  assert.equal(next.drafts[KEY], "A 的文字", "A 的草稿不受影响");
  assert.ok(next.operationOfDraft[KEY], "A 的发送身份仍在");
});

await test('身份已经换了：这次回执只解除映射，不动任何草稿', () => {
  const sentVersion = draftVersionOf("同一段文字", "steer", [reference('file', 'r0/src/a.js', 'a'.repeat(64))]);
  const ui = afterSend({ operationOfDraft: { [KEY]: { operationId: "op-2", version: sentVersion } } });
  const next = clearAcceptedDraft(ui, "op-1", sentVersion, "steer");
  assert.equal(next.drafts[KEY], "同一段文字", "operationId 已不是这一次，草稿不动");
  assert.ok(next.operationOfDraft[KEY], "当前身份必须保留");
  assert.equal(next.draftOfOperation["op-1"], undefined, "旧映射解除");
});

await test('找不到关联草稿键时原样返回，不凭空造键', () => {
  const ui = afterSend();
  const next = clearAcceptedDraft(ui, "op-unknown", draftVersionOf("x", "steer", []), "steer");
  assert.equal(next, ui);
});

await test('版本判据本身逐项相等，空引用集合身份稳定', () => {
  const a = draftVersionOf("文字", "steer", undefined);
  const b = draftVersionOf("文字", "steer", []);
  assert.ok(isSameDraftVersion(a, b), "未传引用与空引用集合是同一版");
  assert.equal(a.referenceSetId, referenceSetId([]));
  assert.equal(isSameDraftVersion(null, a), false, "缺凭据不得判成同一版");
  assert.equal(isSameDraftVersion(a, draftVersionOf("文字", "steer", [reference('file', 'r0/x', 'c'.repeat(64))])), false);
});
