import { createHash } from "node:crypto";

export type SearchableMessageRole = "user" | "assistant";

export interface SearchableMessage {
  role: SearchableMessageRole;
  body: string;
}

export function extractSearchableMessage(message: unknown): SearchableMessage | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const role = (message as { role?: unknown }).role;
  if (role !== "user" && role !== "assistant") return undefined;
  const content = (message as { content?: unknown }).content;
  let body = "";
  if (typeof content === "string") body = content;
  else if (Array.isArray(content)) {
    body = content
      .filter((part): part is { type: "text"; text: string } => (
        typeof part === "object"
        && part !== null
        && !Array.isArray(part)
        && (part as { type?: unknown }).type === "text"
        && typeof (part as { text?: unknown }).text === "string"
      ))
      .map((part) => part.text)
      .join("\n");
  }
  if (!body.trim()) return undefined;
  return { role, body };
}

export function searchEntryDigest(role: SearchableMessageRole, body: string): string {
  return `v1:${createHash("sha256").update(role).update("\0").update(body).digest("hex")}`;
}
