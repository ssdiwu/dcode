import type { MessageRow } from "../workbench.ts";

export interface ConversationTurn {
  id: string;
  question: string;
  answer: string;
}
export interface TurnAnchor { id: string; top: number }

const preview = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 180);

/** A turn starts at a user message; tools and thinking never create extra turns. */
export function conversationTurns(rows: readonly MessageRow[], liveAnswer = ""): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const row of rows) {
    const text = row.parts.filter(part => part.kind === "text").map(part => part.text).join("\n");
    if (row.role === "user") {
      const imageCount = row.parts.filter(part => part.kind === "image").length;
      turns.push({id: row.id, question: preview(text) || preview(row.parts.filter(part=>part.attachment).map(part=>part.attachment!.name).join("、")) || (imageCount ? `图片消息（${imageCount} 张）` : "用户消息"), answer: ""});
    } else if (row.role === "assistant" && turns.length) {
      const last = turns[turns.length - 1];
      last.answer = preview([last.answer, text].filter(Boolean).join(" "));
    }
  }
  if (turns.length && liveAnswer) {
    const last = turns[turns.length - 1];
    last.answer = preview([last.answer, liveAnswer].filter(Boolean).join(" "));
  }
  return turns;
}

export function turnIndexAtPosition(y: number, height: number, count: number): number {
  if (count <= 0 || height <= 0) return -1;
  return Math.min(count - 1, Math.max(0, Math.floor(y / height * count)));
}

export function currentTurn(anchors: readonly TurnAnchor[], readingTop: number): string | null {
  let id = anchors[0]?.id ?? null;
  for (const anchor of anchors) {
    if (anchor.top > readingTop) break;
    id = anchor.id;
  }
  return id;
}
