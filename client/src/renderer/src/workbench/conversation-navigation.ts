import { uiText } from "../../../shared/ui-language.ts";
import type { MessageRow } from "../workbench.ts";

export interface ConversationTurn {
  id: string;
  question: string;
  answer: string;
}
export interface TurnAnchor { id: string; top: number }

const preview = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 180);

/** Navigation entries come from visible human inputs, including steering within one run. */
export function conversationTurns(rows: readonly MessageRow[], liveAnswer = ""): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let inputGroup:string|undefined;
  let answerTarget: ConversationTurn | undefined;
  for (const row of rows) {
    const text = row.parts.filter(part => part.kind === "text").map(part => part.text).join("\n");
    if (row.role === "user" && row.navigationEligible !== false) {
      inputGroup=row.collaborationGroupId;
      const imageCount = row.parts.filter(part => part.kind === "image").length;
      answerTarget = {id: row.id, question: preview(text) || preview(row.parts.filter(part=>part.attachment).map(part=>part.attachment!.name).join("、")) || (imageCount ? uiText("图片消息（{0} 张）", [imageCount]) : uiText("用户消息")), answer: ""};
      turns.push(answerTarget);
    } else if (row.role === "coordination" || row.inputBoundary || row.role === "user") {
      // A coordinator handoff, native non-user entry or progress boundary is not a human query.
      answerTarget = undefined;
      inputGroup = row.collaborationGroupId;
    } else if (row.role === "assistant" && answerTarget && (!row.collaborationGroupId||row.collaborationGroupId===inputGroup)) {
      answerTarget.answer = preview([answerTarget.answer, text].filter(Boolean).join(" "));
    }
  }
  if (answerTarget && liveAnswer) {
    answerTarget.answer = preview([answerTarget.answer, liveAnswer].filter(Boolean).join(" "));
  }
  return turns;
}

export function currentTurn(anchors: readonly TurnAnchor[], readingTop: number): string | null {
  let id = anchors[0]?.id ?? null;
  for (const anchor of anchors) {
    if (anchor.top > readingTop) break;
    id = anchor.id;
  }
  return id;
}
