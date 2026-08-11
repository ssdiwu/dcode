import { basename } from "node:path";

const SESSION_PREVIEW_LIMIT = 280;

export function compactSessionPreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= SESSION_PREVIEW_LIMIT
    ? compact
    : `${compact.slice(0, SESSION_PREVIEW_LIMIT - 1)}…`;
}

export function sessionDisplayTitle(input: {
  name?: string;
  firstMessage: string;
  cwd: string;
}): string {
  if (input.name?.trim()) return input.name.trim();
  if (input.firstMessage) return input.firstMessage;
  return basename(input.cwd) || input.cwd;
}
