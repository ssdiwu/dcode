import { resolve } from "node:path";

export interface StructuredToolChangeInput {
  sessionId: string;
  runId: string;
  pathEntryId?: string;
  cwd: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  isError: boolean;
  occurredAt?: string;
}

export interface StructuredToolChange {
  recordId: string;
  sessionId: string;
  runId: string;
  pathEntryId?: string;
  toolCallId: string;
  operation: "edit" | "create";
  filePath: string;
  firstChangedLine?: number;
  additions: number;
  deletions: number;
  occurredAt: string;
  source: "structured-tool-v1";
}

export function structuredToolChange(input: StructuredToolChangeInput): StructuredToolChange | undefined {
  if (input.isError) return undefined;
  const result = record(input.result);
  const details = record(result?.details);
  if (!details) return undefined;

  if (input.toolName === "edit") {
    const patch = multilineString(details.patch, 16 * 1_024 * 1_024);
    if (!patch) return undefined;
    const summary = summarizeUnifiedPatch(patch);
    if (!summary || (summary.additions === 0 && summary.deletions === 0)) return undefined;
    const detailLine = positiveInteger(details.firstChangedLine);
    return baseRecord(input, {
      operation: "edit",
      filePath: canonicalFilePath(input.cwd, summary.path),
      firstChangedLine: detailLine ?? summary.firstChangedLine,
      additions: summary.additions,
      deletions: summary.deletions,
    });
  }

  if (input.toolName === "write" && details.created === true) {
    const path = string(details.path);
    const lines = nonNegativeInteger(details.lines);
    if (!path || lines === undefined) return undefined;
    return baseRecord(input, {
      operation: "create",
      filePath: canonicalFilePath(input.cwd, path),
      firstChangedLine: 1,
      additions: lines,
      deletions: 0,
    });
  }

  return undefined;
}

function baseRecord(
  input: StructuredToolChangeInput,
  change: Pick<StructuredToolChange, "operation" | "filePath" | "firstChangedLine" | "additions" | "deletions">,
): StructuredToolChange {
  return {
    recordId: `${input.sessionId}:${input.runId}:${input.toolCallId}`,
    sessionId: input.sessionId,
    runId: input.runId,
    ...(input.pathEntryId ? { pathEntryId: input.pathEntryId } : {}),
    toolCallId: input.toolCallId,
    ...change,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    source: "structured-tool-v1",
  };
}

function summarizeUnifiedPatch(patch: string): {
  path: string;
  firstChangedLine?: number;
  additions: number;
  deletions: number;
} | undefined {
  const lines = patch.split("\n");
  const pathLine = lines.find((line) => line.startsWith("+++ "));
  if (!pathLine) return undefined;
  let path = pathLine.slice(4);
  if (path === "/dev/null") return undefined;
  if (path.startsWith("b/")) path = path.slice(2);
  if (!validBoundedString(path, 4_096)) return undefined;

  let additions = 0;
  let deletions = 0;
  let firstChangedLine: number | undefined;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = /\+(\d+)/.exec(line);
      const parsed = match ? Number(match[1]) : Number.NaN;
      if (firstChangedLine === undefined && Number.isSafeInteger(parsed) && parsed > 0) {
        firstChangedLine = parsed;
      }
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++ ")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("--- ")) deletions += 1;
  }
  return { path, ...(firstChangedLine ? { firstChangedLine } : {}), additions, deletions };
}

function canonicalFilePath(cwd: string, path: string): string {
  return resolve(cwd, path);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string | undefined {
  return validBoundedString(value, 4_096) ? value : undefined;
}

function multilineString(value: unknown, maximumUTF16Length: number): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumUTF16Length
    && !value.includes("\0")
    ? value
    : undefined;
}

function validBoundedString(value: unknown, maximumUTF16Length: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumUTF16Length
    && !value.includes("\0")
    && !value.includes("\n")
    && !value.includes("\r");
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
