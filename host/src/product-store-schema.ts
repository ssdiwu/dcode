import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prepareManagedDCodeDirectory, type DCodeDataRootLayout } from "./dcode-data-root.js";
import { redactCredentialText } from "./credential-material.js";
import {
  verifyLegacyMigrationSources,
  type LegacyMigrationPlan,
  type LegacyStoreKind,
  type LegacySourceManifestEntry,
} from "./legacy-migration.js";

export const PRODUCT_STORE_SCHEMA_VERSION = 2;
export const PRODUCT_STORE_APPLICATION_ID = 0x44434f44; // "DCOD"

const TASK_CONTEXT_SCHEMA_SQL = `
  CREATE TABLE task_context_sets (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE task_context_sources (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('scope_document', 'global_knowledge')),
    root_path TEXT NOT NULL,
    relative_path TEXT NOT NULL CHECK(length(relative_path) BETWEEN 1 AND 4096),
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(
      (source_kind = 'scope_document' AND root_path = '')
      OR (source_kind = 'global_knowledge' AND root_path <> '')
    ),
    UNIQUE(task_id, source_kind, root_path, relative_path),
    UNIQUE(task_id, ordinal)
  ) STRICT;
`;

export class ProductStoreSchemaError extends Error {
  constructor(
    readonly code:
      | "PRODUCT_STORE_SCHEMA_UNSUPPORTED"
      | "PRODUCT_STORE_SCHEMA_INVALID"
      | "PRODUCT_STORE_INTEGRITY_FAILED",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProductStoreSchemaError";
  }
}

export interface ProductStoreBootstrapIdentity {
  userId: string;
  userHome: string;
}

interface BuiltinProfileDefinition {
  id: string;
  role: "coordinator" | "explore" | "worker" | "verifier";
  name: string;
  roleContract: string;
}

const BUILTIN_PROFILES: readonly BuiltinProfileDefinition[] = [
  {
    id: "builtin-coordinator",
    role: "coordinator",
    name: "Coordinator",
    roleContract: "Own the Task-level plan, delegate bounded work, resolve requests, and synthesize evidence. Never accept the Task on the user's behalf.",
  },
  {
    id: "builtin-explore",
    role: "explore",
    name: "Explore",
    roleContract: "Investigate a bounded question, separate facts from inference, and return findings with evidence without expanding the assignment.",
  },
  {
    id: "builtin-worker",
    role: "worker",
    name: "Worker",
    roleContract: "Implement the assigned bounded change in the provided workspace and report concrete results, failures, and artifacts.",
  },
  {
    id: "builtin-verifier",
    role: "verifier",
    name: "Verifier",
    roleContract: "Independently verify the assigned acceptance signals and report evidence without treating another Agent's claim as proof.",
  },
] as const;

function scalarPragma(database: DatabaseSync, pragma: string): unknown {
  const row = database.prepare(pragma).get() as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

function schemaFingerprint(database: DatabaseSync): string {
  const definitions = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
  return `sha256:${createHash("sha256").update(JSON.stringify(definitions)).digest("hex")}`;
}

function rollback(database: DatabaseSync): void {
  if (!database.isTransaction) return;
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original failure. The unpublished candidate is deleted by the caller.
  }
}

function migrationSourceId(migrationId: string, source: LegacySourceManifestEntry): string {
  return `legacy-source-${createHash("sha256")
    .update(`${migrationId}\0${source.kind}\0${source.path}\0${source.digest}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function migrationRecordId(prefix: string, identity: string): string {
  return `${prefix}-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function legacyDocument(plan: LegacyMigrationPlan, kind: LegacyStoreKind): Record<string, unknown> | undefined {
  const document = plan.sources.find((source) => source.kind === kind)?.document;
  return typeof document === "object" && document !== null && !Array.isArray(document)
    ? document as Record<string, unknown>
    : undefined;
}

function records(document: Record<string, unknown> | undefined, key: string): Record<string, unknown>[] {
  const value = document?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => (
      typeof item === "object" && item !== null && !Array.isArray(item)
    ))
    : [];
}

function legacyString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] as string : undefined;
}

function redactLegacyText(source: string): string {
  return redactCredentialText(source).text;
}

function sanitizeLegacyValue(value: unknown, key = ""): unknown {
  if (/api[_-]?key|token|authorization|password|secret|headers?/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactLegacyText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeLegacyValue(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([childKey, child]) => [childKey, sanitizeLegacyValue(child, childKey)]));
  }
  return value;
}

function legacyDate(value: unknown): string | undefined {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const swiftReferenceDate = Date.UTC(2001, 0, 1);
    return new Date(swiftReferenceDate + value * 1_000).toISOString();
  }
  return undefined;
}

function applyLegacyProductState(
  database: DatabaseSync,
  identity: ProductStoreBootstrapIdentity,
  plan: LegacyMigrationPlan,
  now: string,
): void {
  const adoptionBySource = new Map(plan.adoptedSessions.map((adoption) => [adoption.sourceSessionId, adoption]));
  const unresolved = database.prepare(`
    INSERT INTO migration_unresolved_references(
      id, migration_id, source_kind, source_identity, reason, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const recordUnresolved = (
    sourceKind: string,
    sourceIdentity: string,
    reason: string,
    details: unknown,
  ): void => {
    unresolved.run(
      migrationRecordId("unresolved", `${plan.id}\0${sourceKind}\0${sourceIdentity}`),
      plan.id,
      sourceKind,
      sourceIdentity,
      reason,
      JSON.stringify(sanitizeLegacyValue(details)),
      now,
    );
  };

  const legacyRunIds = new Map<string, string>();
  const insertLegacyRun = database.prepare(`
    INSERT INTO legacy_session_runs(
      id, task_id, session_id, source_run_id, lineage_status,
      status, details_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?, ?)
  `);
  const ensureLegacyRun = (
    sourceSessionId: string,
    sourceRunId: string,
    status: "completed" | "failed" | "aborted" | "interrupted" | "unknown",
    details: unknown,
  ): string | undefined => {
    const adoption = adoptionBySource.get(sourceSessionId);
    if (!adoption) {
      recordUnresolved("legacyRun", `${sourceSessionId}:${sourceRunId}`, "pi_session_requires_explicit_import", details);
      return undefined;
    }
    const key = `${sourceSessionId}\0${sourceRunId}`;
    const existing = legacyRunIds.get(key);
    if (existing) {
      if (status !== "unknown") {
        database.prepare(`
          UPDATE legacy_session_runs SET status = ?, details_json = ?, updated_at = ? WHERE id = ?
        `).run(status, JSON.stringify(sanitizeLegacyValue(details)), now, existing);
      }
      return existing;
    }
    const id = migrationRecordId("legacy-run", key);
    insertLegacyRun.run(
      id,
      adoption.taskId,
      adoption.sessionId,
      sourceRunId,
      status,
      JSON.stringify(sanitizeLegacyValue(details)),
      now,
      now,
    );
    legacyRunIds.set(key, id);
    return id;
  };

  applyLegacyDrafts(database, plan, adoptionBySource, recordUnresolved, now);
  applyLegacyArchiveAndPins(database, plan, adoptionBySource, recordUnresolved, now);
  applyLegacyQueues(database, plan, adoptionBySource, recordUnresolved, ensureLegacyRun, now);
  applyLegacyAttentionChangesAndEvidence(
    database,
    plan,
    adoptionBySource,
    recordUnresolved,
    ensureLegacyRun,
    now,
  );
  applyLegacySelfEvolution(database, plan, now);
  applyLegacyRuntimeConfiguration(database, identity, plan, now);
}

type LegacyAdoption = LegacyMigrationPlan["adoptedSessions"][number];
type AdoptionMap = Map<string, LegacyAdoption>;
type RecordUnresolved = (sourceKind: string, sourceIdentity: string, reason: string, details: unknown) => void;
type EnsureLegacyRun = (
  sourceSessionId: string,
  sourceRunId: string,
  status: "completed" | "failed" | "aborted" | "interrupted" | "unknown",
  details: unknown,
) => string | undefined;

function invalidLegacyRecord(sourceKind: string, details?: unknown): never {
  throw new ProductStoreSchemaError(
    "PRODUCT_STORE_SCHEMA_INVALID",
    "A legacy source passed discovery but contains an invalid record",
    { sourceKind, details: sanitizeLegacyValue(details) },
  );
}

function draftTarget(target: unknown): { sessionId: string; payload: Record<string, unknown> } | undefined {
  if (typeof target !== "object" || target === null || Array.isArray(target)) return undefined;
  const record = target as Record<string, unknown>;
  for (const kind of ["path", "pending"] as const) {
    const payload = record[kind];
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      const value = payload as Record<string, unknown>;
      if (typeof value.sessionID === "string") return { sessionId: value.sessionID, payload: { kind, ...value } };
    }
  }
  return undefined;
}

function applyLegacyDrafts(
  database: DatabaseSync,
  plan: LegacyMigrationPlan,
  adoptions: AdoptionMap,
  unresolved: RecordUnresolved,
  now: string,
): void {
  const document = legacyDocument(plan, "sessionDrafts");
  if (!document) return;
  const insertDraft = database.prepare(`
    INSERT INTO composer_drafts(
      id, task_id, session_id, draft_kind, text, payload_json,
      source_ordinal, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  for (const [ordinal, record] of records(document, "records").entries()) {
    const target = draftTarget(record.target);
    if (!target) {
      invalidLegacyRecord("sessionDraft", { ordinal });
    }
    const adoption = adoptions.get(target.sessionId);
    if (!adoption) {
      unresolved("sessionDraft", target.sessionId, "pi_session_requires_explicit_import", record);
      continue;
    }
    insertDraft.run(
      migrationRecordId("draft", `${plan.id}\0${ordinal}\0${target.sessionId}`),
      adoption.taskId,
      adoption.sessionId,
      "session_path",
      redactLegacyText(typeof record.text === "string" ? record.text : ""),
      JSON.stringify(sanitizeLegacyValue({ target: target.payload, updatedAt: record.updatedAt ?? null })),
      ordinal,
      typeof record.updatedAt === "string" ? record.updatedAt : now,
      typeof record.updatedAt === "string" ? record.updatedAt : now,
    );
  }
  if (typeof document.activeTargets === "object" && document.activeTargets !== null && !Array.isArray(document.activeTargets)) {
    const upsertSelection = database.prepare(`
      INSERT INTO session_path_selections(
        session_id, selected_path_id, pending_action_json, revision, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        selected_path_id = excluded.selected_path_id,
        pending_action_json = excluded.pending_action_json,
        revision = session_path_selections.revision + 1,
        updated_at = excluded.updated_at
    `);
    for (const [sourceSessionId, value] of Object.entries(document.activeTargets as Record<string, unknown>)) {
      const target = draftTarget(value);
      const adoption = adoptions.get(sourceSessionId);
      if (!target || target.sessionId !== sourceSessionId || !adoption) {
        unresolved("sessionPathSelection", sourceSessionId, "pi_session_requires_explicit_import_or_invalid_target", value);
        continue;
      }
      upsertSelection.run(
        adoption.sessionId,
        typeof target.payload.pathID === "string" ? target.payload.pathID : null,
        target.payload.kind === "pending" ? JSON.stringify(target.payload) : null,
        now,
        now,
      );
    }
  }
  if (typeof document.newSessionDraft === "object" && document.newSessionDraft !== null) {
    const draft = document.newSessionDraft as Record<string, unknown>;
    insertDraft.run(
      migrationRecordId("draft", `${plan.id}\0new-session`),
      null,
      null,
      "new_task",
      redactLegacyText(typeof draft.text === "string" ? draft.text : ""),
      JSON.stringify(sanitizeLegacyValue(draft)),
      null,
      now,
      now,
    );
  }
}

function applyLegacyArchiveAndPins(
  database: DatabaseSync,
  plan: LegacyMigrationPlan,
  adoptions: AdoptionMap,
  unresolved: RecordUnresolved,
  now: string,
): void {
  const archiveDocument = legacyDocument(plan, "sessionArchives");
  const archiveRecords = records(archiveDocument, "records");
  const pending = archiveDocument?.pending;
  if (typeof pending === "object" && pending !== null && !Array.isArray(pending)) archiveRecords.push(pending as Record<string, unknown>);
  const seenArchives = new Set<string>();
  const insertArchive = database.prepare(`
    INSERT INTO session_archive_states(
      session_id, archived_at, copied_to_session_id, source_title, source_cwd,
      details_json, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  for (const record of archiveRecords) {
    const sourceSessionId = legacyString(record, "sessionID");
    if (!sourceSessionId) invalidLegacyRecord("sessionArchive");
    if (seenArchives.has(sourceSessionId)) continue;
    seenArchives.add(sourceSessionId);
    const adoption = adoptions.get(sourceSessionId);
    if (!adoption) {
      unresolved("sessionArchive", sourceSessionId, "pi_session_requires_explicit_import", record);
      continue;
    }
    insertArchive.run(
      adoption.sessionId,
      legacyString(record, "archivedAt") ?? now,
      legacyString(record, "copiedToSessionID") ?? null,
      legacyString(record, "sourceTitle") ?? adoption.title,
      legacyString(record, "sourceCwd") ?? adoption.historicalCwd,
      JSON.stringify({
        copiedToTitle: record.copiedToTitle ?? null,
        copiedToCwd: record.copiedToCwd ?? null,
        sourceSessionId,
      }),
      now,
      now,
    );
  }

  const pinDocument = legacyDocument(plan, "sessionPins");
  const insertPin = database.prepare(`
    INSERT INTO session_user_states(
      session_id, pinned_at, hidden, revision, created_at, updated_at
    ) VALUES (?, ?, 0, 1, ?, ?)
  `);
  for (const record of records(pinDocument, "records")) {
    const sourceSessionId = legacyString(record, "sessionID");
    if (!sourceSessionId) invalidLegacyRecord("sessionPin");
    const adoption = adoptions.get(sourceSessionId);
    if (!adoption) {
      unresolved("sessionPin", sourceSessionId, "pi_session_requires_explicit_import", record);
      continue;
    }
    insertPin.run(adoption.sessionId, legacyString(record, "pinnedAt") ?? now, now, now);
  }
}

function applyLegacyQueues(
  database: DatabaseSync,
  plan: LegacyMigrationPlan,
  adoptions: AdoptionMap,
  unresolved: RecordUnresolved,
  ensureLegacyRun: EnsureLegacyRun,
  now: string,
): void {
  const document = legacyDocument(plan, "followUpQueues");
  const insertQueue = database.prepare(`
    INSERT INTO follow_up_queues(
      id, task_id, session_id, active_legacy_run_id, path_id,
      lineage_entry_id, pause_reason, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const insertItem = database.prepare(`
    INSERT INTO follow_up_items(
      id, queue_id, ordinal, body, state, prompt_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [queueOrdinal, queue] of records(document, "queues").entries()) {
    const sourceSessionId = legacyString(queue, "sessionID");
    if (!sourceSessionId) invalidLegacyRecord("followUpQueue", { queueOrdinal });
    const adoption = adoptions.get(sourceSessionId);
    if (!adoption) {
      unresolved("followUpQueue", sourceSessionId, "pi_session_requires_explicit_import", queue);
      continue;
    }
    const sourceRunId = legacyString(queue, "activeRunID");
    const activeLegacyRunId = sourceRunId
      ? ensureLegacyRun(sourceSessionId, sourceRunId, "unknown", { source: "followUpQueue", interrupted: true })
      : undefined;
    const items = Array.isArray(queue.items)
      ? queue.items.filter((item): item is Record<string, unknown> => (
        typeof item === "object" && item !== null && !Array.isArray(item)
      ))
      : [];
    const hasDispatching = items.some((item) => item.state === "dispatching");
    const pauseReason = sourceRunId
      ? "runOutcomeUnknown"
      : hasDispatching
        ? "dispatchUnknown"
        : typeof queue.pauseReason === "string"
          ? queue.pauseReason
          : items.length > 0
            ? "manualResume"
            : null;
    const queueId = typeof queue.id === "string" && queue.id
      ? queue.id
      : migrationRecordId("queue", `${plan.id}\0${sourceSessionId}\0${queueOrdinal}`);
    insertQueue.run(
      queueId,
      adoption.taskId,
      adoption.sessionId,
      activeLegacyRunId ?? null,
      legacyString(queue, "pathID") ?? null,
      legacyString(queue, "lineageEntryID") ?? null,
      pauseReason,
      legacyString(queue, "createdAt") ?? now,
      legacyString(queue, "updatedAt") ?? now,
    );
    for (const [itemOrdinal, item] of items.entries()) {
      const sourceState = legacyString(item, "state") ?? "pending";
      const state = sourceState === "dispatching" ? "unknown" : sourceState;
      insertItem.run(
        typeof item.id === "string" && item.id
          ? item.id
          : migrationRecordId("queue-item", `${queueId}\0${itemOrdinal}`),
        queueId,
        itemOrdinal,
        redactLegacyText(legacyString(item, "text") ?? ""),
        state,
        legacyString(item, "promptID") ?? null,
        legacyString(item, "createdAt") ?? now,
        legacyString(item, "updatedAt") ?? now,
      );
    }
  }
}

function applyLegacyAttentionChangesAndEvidence(
  database: DatabaseSync,
  plan: LegacyMigrationPlan,
  adoptions: AdoptionMap,
  unresolved: RecordUnresolved,
  ensureLegacyRun: EnsureLegacyRun,
  now: string,
): void {
  const insertAttention = database.prepare(`
    INSERT INTO session_attention(
      session_id, legacy_run_id, completion_id, entry_id, completed_at,
      presented_at, notified_at, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  for (const record of records(legacyDocument(plan, "activityAttention"), "records")) {
    const sourceSessionId = legacyString(record, "sessionID");
    const sourceRunId = legacyString(record, "runID");
    if (!sourceSessionId || !sourceRunId) invalidLegacyRecord("activityAttention");
    const adoption = adoptions.get(sourceSessionId);
    if (!adoption) {
      unresolved("activityAttention", sourceSessionId, "pi_session_requires_explicit_import", record);
      continue;
    }
    const legacyRunId = ensureLegacyRun(sourceSessionId, sourceRunId, "completed", {
      source: "activityAttention",
      completionID: record.completionID ?? null,
    });
    insertAttention.run(
      adoption.sessionId,
      legacyRunId ?? null,
      legacyString(record, "completionID") ?? `${sourceRunId}:unknown`,
      legacyString(record, "entryID") ?? "unknown",
      legacyString(record, "completedAt") ?? now,
      legacyString(record, "presentedAt") ?? null,
      legacyString(record, "notifiedAt") ?? null,
      now,
      now,
    );
  }

  const insertMutation = database.prepare(`
    INSERT INTO session_mutations(
      id, task_id, session_id, legacy_run_id, source_record_id,
      tool_call_id, operation, file_path, additions, deletions,
      first_changed_line, occurred_at, source_kind, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const record of records(legacyDocument(plan, "sessionChanges"), "records")) {
    const sourceSessionId = legacyString(record, "sessionId");
    const sourceRunId = legacyString(record, "runId");
    const sourceRecordId = legacyString(record, "recordId");
    if (!sourceSessionId || !sourceRunId || !sourceRecordId) invalidLegacyRecord("sessionMutation");
    const adoption = adoptions.get(sourceSessionId);
    if (!adoption) {
      unresolved("sessionMutation", sourceRecordId, "pi_session_requires_explicit_import", {
        sessionId: sourceSessionId,
        runId: sourceRunId,
        filePath: record.filePath ?? null,
      });
      continue;
    }
    const legacyRunId = ensureLegacyRun(sourceSessionId, sourceRunId, "unknown", { source: "sessionMutation" });
    insertMutation.run(
      migrationRecordId("mutation", sourceRecordId),
      adoption.taskId,
      adoption.sessionId,
      legacyRunId ?? null,
      sourceRecordId,
      legacyString(record, "toolCallId") ?? "unknown",
      legacyString(record, "operation") ?? "edit",
      legacyString(record, "filePath") ?? adoption.historicalCwd,
      typeof record.additions === "number" ? record.additions : 0,
      typeof record.deletions === "number" ? record.deletions : 0,
      typeof record.firstChangedLine === "number" ? record.firstChangedLine : null,
      legacyString(record, "occurredAt") ?? now,
      legacyString(record, "source") ?? "legacy",
      now,
    );
  }

  const insertEvidence = database.prepare(`
    INSERT INTO evidence_records(
      id, task_id, session_id, legacy_run_id, agent_run_id,
      source_record_id, evidence_kind, command_redacted, exit_kind,
      exit_code, started_at, ended_at, cwd, payload_json, created_at
    ) VALUES (?, ?, ?, ?, NULL, ?, 'command', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const record of records(legacyDocument(plan, "verificationEvidence"), "records")) {
    const sourceSessionId = legacyString(record, "sessionId");
    const sourceRunId = legacyString(record, "runId");
    const sourceRecordId = legacyString(record, "recordId");
    if (!sourceSessionId || !sourceRunId || !sourceRecordId) invalidLegacyRecord("verificationEvidence");
    const adoption = adoptions.get(sourceSessionId);
    if (!adoption) {
      unresolved("verificationEvidence", sourceRecordId, "pi_session_requires_explicit_import", {
        sessionId: sourceSessionId,
        runId: sourceRunId,
      });
      continue;
    }
    const exitKind = legacyString(record, "exitKind") ?? "unknown";
    const runStatus = exitKind === "ok" ? "completed" : exitKind === "failure" ? "failed" : "unknown";
    const legacyRunId = ensureLegacyRun(sourceSessionId, sourceRunId, runStatus, {
      source: "verificationEvidence",
      exitKind,
    });
    const startedAt = legacyDate(record.startedAt);
    const endedAt = legacyDate(record.endedAt);
    if (!startedAt || !endedAt) {
      throw new ProductStoreSchemaError(
        "PRODUCT_STORE_SCHEMA_INVALID",
        "Legacy verification evidence contains an invalid date",
        { sourceRecordId },
      );
    }
    insertEvidence.run(
      migrationRecordId("evidence", sourceRecordId),
      adoption.taskId,
      adoption.sessionId,
      legacyRunId ?? null,
      sourceRecordId,
      redactLegacyText(legacyString(record, "command") ?? ""),
      exitKind,
      typeof record.exitCode === "number" ? record.exitCode : null,
      startedAt,
      endedAt,
      legacyString(record, "cwd") ?? adoption.historicalCwd,
      JSON.stringify({
        toolCallId: record.toolCallId ?? null,
        modelProvider: record.modelProvider ?? null,
        modelId: record.modelId ?? null,
        gitRevision: record.gitRevision ?? null,
      }),
      now,
    );
  }
}

function applyLegacySelfEvolution(
  database: DatabaseSync,
  plan: LegacyMigrationPlan,
  now: string,
): void {
  const document = legacyDocument(plan, "selfEvolution");
  if (!document) return;
  const documentRevision = typeof document.revision === "number" ? document.revision : 0;
  const insertRun = database.prepare(`
    INSERT INTO self_evolution_runs(
      id, source_run_id, state, document_revision, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = database.prepare(`
    INSERT INTO self_evolution_events(
      id, self_evolution_run_id, ordinal, event_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const run of records(document, "runs")) {
    const sourceRunId = legacyString(run, "id");
    if (!sourceRunId) invalidLegacyRecord("selfEvolution");
    const id = migrationRecordId("self-evolution", sourceRunId);
    const events = Array.isArray(run.events)
      ? run.events.filter((item): item is Record<string, unknown> => (
        typeof item === "object" && item !== null && !Array.isArray(item)
      ))
      : [];
    const { events: _events, ...payload } = run;
    insertRun.run(
      id,
      sourceRunId,
      legacyString(run, "state") ?? "recovery_required",
      documentRevision,
      JSON.stringify(sanitizeLegacyValue(payload)),
      legacyString(run, "createdAt") ?? now,
      legacyString(run, "updatedAt") ?? now,
    );
    for (const [ordinal, event] of events.entries()) {
      insertEvent.run(
        typeof event.id === "string" && event.id
          ? event.id
          : migrationRecordId("self-evolution-event", `${sourceRunId}\0${ordinal}`),
        id,
        ordinal,
        JSON.stringify(sanitizeLegacyValue(event)),
        legacyString(event, "occurredAt") ?? now,
      );
    }
  }
  if (typeof document.bootstrapRecovery === "object" && document.bootstrapRecovery !== null) {
    const recovery = document.bootstrapRecovery as Record<string, unknown>;
    database.prepare(`
      INSERT INTO self_evolution_recovery(
        id, self_evolution_run_id, payload_json, state,
        revision, created_at, updated_at
      ) VALUES (?, NULL, ?, 'pending', 1, ?, ?)
    `).run(
      typeof recovery.id === "string" && recovery.id
        ? recovery.id
        : migrationRecordId("self-evolution-recovery", plan.id),
      JSON.stringify(sanitizeLegacyValue(recovery)),
      legacyString(recovery, "observedAt") ?? now,
      now,
    );
  }
}

function packageSourceKey(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const source = (value as { source?: unknown }).source;
    if (typeof source === "string" && source.trim()) return source.trim();
  }
  return undefined;
}

function applyLegacyRuntimeConfiguration(
  database: DatabaseSync,
  identity: ProductStoreBootstrapIdentity,
  plan: LegacyMigrationPlan,
  now: string,
): void {
  const userDefaults = plan.userDefaults;
  const insertUserSetting = database.prepare(`
    INSERT INTO product_settings(key, value_json, source_kind, revision, created_at, updated_at)
    VALUES (?, ?, 'legacy_user_defaults', 1, ?, ?)
  `);
  for (const key of [
    "dcode.appearance",
    "dcode.appearance.fontScale",
    "dcode.sidebar.userHidden",
    "dcode.inspector.userHidden",
    "dcode.sidebar.width",
    "dcode.inspector.width",
    "dcode.notifications.completionEnabled",
  ]) {
    if (userDefaults?.[key] === undefined) continue;
    insertUserSetting.run(key, JSON.stringify(userDefaults[key]), now, now);
  }
  if (userDefaults?.["dcode.selfBuildSourceRoot"] !== undefined) {
    database.prepare(`
      INSERT INTO creation_mode_settings(
        key, value_json, source_kind, revision, created_at, updated_at
      ) VALUES ('dcode.selfBuildSourceRoot', ?, 'legacy_user_defaults', 1, ?, ?)
    `).run(JSON.stringify(userDefaults["dcode.selfBuildSourceRoot"]), now, now);
  }
  if (
    userDefaults?.["dcode.selfBuildRestart"] === true
    || userDefaults?.["dcode.selfBuildRestartKind"] !== undefined
    || userDefaults?.["dcode.selfBuildPendingSessionId"] !== undefined
    || userDefaults?.["dcode.selfEvolutionPendingRunId"] !== undefined
  ) {
    const payload = {
      restart: userDefaults["dcode.selfBuildRestart"] ?? null,
      kind: userDefaults["dcode.selfBuildRestartKind"] ?? null,
      pendingSessionId: userDefaults["dcode.selfBuildPendingSessionId"] ?? null,
      selfEvolutionRunId: userDefaults["dcode.selfEvolutionPendingRunId"] ?? null,
    };
    database.prepare(`
      INSERT INTO recovery_intents(
        id, intent_kind, payload_json, state, source_kind,
        revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'legacy_user_defaults', 1, ?, ?)
    `).run(
      migrationRecordId("recovery-intent", plan.id),
      typeof payload.kind === "string" ? payload.kind : "legacy-bootstrap",
      JSON.stringify(payload),
      typeof payload.kind === "string" ? "pending" : "unknown",
      now,
      now,
    );
  }

  const settings = legacyDocument(plan, "piSettings");
  const insertSetting = database.prepare(`
    INSERT INTO product_settings(key, value_json, source_kind, revision, created_at, updated_at)
    VALUES (?, ?, 'legacy_pi_settings', 1, ?, ?)
  `);
  const settingKeys = [
    "defaultProvider",
    "defaultModel",
    "defaultThinkingLevel",
    "enabledModels",
    "compaction",
    "retry",
    "enableSkillCommands",
    "transport",
  ];
  for (const key of settingKeys) {
    if (settings?.[key] === undefined) continue;
    insertSetting.run(`runtime.${key}`, JSON.stringify(sanitizeLegacyValue(settings[key], key)), now, now);
  }

  const disabledDocument = plan.sources.find((source) => source.kind === "disabledPackages")?.document;
  const disabledKeys = new Set(Array.isArray(disabledDocument)
    ? disabledDocument.flatMap((entry) => packageSourceKey(entry) ?? [])
    : []);
  const packageEntries = [
    ...(Array.isArray(settings?.packages) ? settings.packages : []),
    ...(Array.isArray(disabledDocument) ? disabledDocument : []),
  ];
  const uniquePackages = new Map<string, unknown>();
  for (const entry of packageEntries) {
    const key = packageSourceKey(entry);
    if (key && !uniquePackages.has(key)) uniquePackages.set(key, entry);
  }
  const insertCapability = database.prepare(`
    INSERT INTO capability_sources(
      id, source_key, source_kind, nonsecret_json, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?)
  `);
  const insertCapabilityConfiguration = database.prepare(`
    INSERT INTO capability_configurations(
      id, capability_source_id, scope_kind, user_id, project_id,
      enabled, configuration_json, revision, created_at, updated_at
    ) VALUES (?, ?, 'user', ?, NULL, ?, '{}', 1, ?, ?)
  `);
  for (const [sourceKey, entry] of uniquePackages) {
    const id = migrationRecordId("capability-source", sourceKey);
    insertCapability.run(
      id,
      sourceKey,
      sourceKey.startsWith("npm:") ? "npm" : "path",
      JSON.stringify(sanitizeLegacyValue(entry)),
      now,
      now,
    );
    insertCapabilityConfiguration.run(
      migrationRecordId("capability-config", `${identity.userId}\0${sourceKey}`),
      id,
      identity.userId,
      disabledKeys.has(sourceKey) ? 0 : 1,
      now,
      now,
    );
  }

  const modelSource = plan.sources.find((source) => source.kind === "piModels");
  const modelDocument = modelSource?.document;
  const providers = typeof modelDocument === "object" && modelDocument !== null && !Array.isArray(modelDocument)
    ? (modelDocument as { providers?: unknown }).providers
    : undefined;
  if (!Array.isArray(providers)) return;
  const insertProvider = database.prepare(`
    INSERT INTO model_providers(
      id, name, base_url, api_kind, auth_mode, nonsecret_json,
      revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const insertModel = database.prepare(`
    INSERT INTO model_catalog_entries(
      id, provider_id, model_id, name, context_window, max_tokens,
      reasoning, nonsecret_json, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const insertCredentialReference = database.prepare(`
    INSERT INTO credential_references(
      id, provider_id, reference_kind, locator, configured,
      source_digest, revision, created_at, updated_at
    ) VALUES (?, ?, 'external_auth_bridge', ?, ?, ?, 1, ?, ?)
  `);
  for (const value of providers) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const provider = value as Record<string, unknown>;
    const providerId = legacyString(provider, "id");
    if (!providerId) continue;
    insertProvider.run(
      providerId,
      legacyString(provider, "name") ?? providerId,
      legacyString(provider, "baseUrl") ?? null,
      legacyString(provider, "api") ?? null,
      legacyString(provider, "authMode") ?? "none",
      JSON.stringify(sanitizeLegacyValue({
        headerKeys: provider.headerKeys ?? [],
        compatJson: provider.compatJson ?? null,
        modelOverridesJson: provider.modelOverridesJson ?? null,
      })),
      now,
      now,
    );
    const models = Array.isArray(provider.models)
      ? provider.models.filter((model): model is Record<string, unknown> => (
        typeof model === "object" && model !== null && !Array.isArray(model)
      ))
      : [];
    for (const model of models) {
      const modelId = legacyString(model, "id");
      if (!modelId) continue;
      insertModel.run(
        migrationRecordId("model", `${providerId}\0${modelId}`),
        providerId,
        modelId,
        legacyString(model, "name") ?? modelId,
        typeof model.contextWindow === "number" ? model.contextWindow : null,
        typeof model.maxTokens === "number" ? model.maxTokens : null,
        model.reasoning === true ? 1 : 0,
        JSON.stringify(sanitizeLegacyValue(model)),
        now,
        now,
      );
    }
    insertCredentialReference.run(
      migrationRecordId("credential-reference", providerId),
      providerId,
      `pi-auth-bridge:${providerId}`,
      provider.authConfigured === true ? 1 : 0,
      modelSource?.digest ?? null,
      now,
      now,
    );
  }
}

function applyLegacyMigrationPlan(
  database: DatabaseSync,
  identity: ProductStoreBootstrapIdentity,
  plan: LegacyMigrationPlan,
  now: string,
): void {
  database.prepare(`
    INSERT INTO migration_runs(
      id, source_manifest_json, state, source_digest,
      started_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)
  `).run(
    plan.id,
    JSON.stringify(plan.sourceManifest),
    plan.sourceDigest,
    now,
    now,
    now,
    now,
  );

  const insertLegacySource = database.prepare(`
    INSERT INTO legacy_sources(
      id, source_kind, source_path, source_digest, migration_id,
      state, details_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'promoted', ?, ?, ?)
  `);
  for (const source of plan.sourceManifest) {
    insertLegacySource.run(
      migrationSourceId(plan.id, source),
      source.kind,
      source.path,
      source.digest,
      plan.id,
      JSON.stringify({
        size: source.size,
        modifiedAt: source.modifiedAt,
        containsCredentialMaterial: source.containsCredentialMaterial,
      }),
      now,
      now,
    );
  }

  const insertProject = database.prepare(`
    INSERT INTO projects(id, user_id, title, directory, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `);
  for (const project of plan.projects) {
    insertProject.run(project.id, identity.userId, project.title, project.directory, now, now);
  }

  const insertTask = database.prepare(`
    INSERT INTO tasks(
      id, scope_kind, user_id, project_id, title, goal, acceptance_json,
      cwd, state, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 'draft', 1, ?, ?)
  `);
  const insertSession = database.prepare(`
    INSERT INTO sessions(
      id, task_id, kind, title, runtime_adapter, lineage_status,
      state, revision, created_at, updated_at
    ) VALUES (?, ?, 'coordination', ?, 'pi', 'unknown', 'idle', 1, ?, ?)
  `);
  const insertEntry = database.prepare(`
    INSERT INTO session_entries(
      id, session_id, source_kind, lineage_status, source_entry_id,
      source_parent_entry_id, source_ordinal, source_timestamp,
      message_role, content_json, created_at
    ) VALUES (?, ?, 'legacy_adoption', 'unknown', ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAssignment = database.prepare(`
    INSERT INTO coordinator_assignments(
      id, task_id, session_id, profile_id, revision, created_at, updated_at
    ) VALUES (?, ?, ?, 'builtin-coordinator', 1, ?, ?)
  `);
  const insertPath = database.prepare(`
    INSERT INTO session_paths(
      id, session_id, parent_path_id, source_path_id, source_leaf_entry_id,
      title, is_current, revision, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, 1, ?, ?)
  `);
  const insertPathEntry = database.prepare(`
    INSERT INTO session_path_entries(path_id, entry_id, ordinal)
    VALUES (?, ?, ?)
  `);
  const insertProvenance = database.prepare(`
    INSERT INTO session_provenance(
      id, task_id, session_id, source_kind, source_session_id,
      source_path, source_digest, historical_cwd, lineage_status,
      details_json, created_at
    ) VALUES (?, ?, ?, 'legacy_adoption', ?, ?, ?, ?, 'unknown', ?, ?)
  `);

  for (const adoption of plan.adoptedSessions) {
    const projectId = adoption.scope.kind === "project" ? adoption.scope.projectId : undefined;
    const project = projectId
      ? plan.projects.find((candidate) => candidate.id === projectId)
      : undefined;
    const cwd = project?.directory ?? identity.userHome;
    const taskTitle = `Legacy Task · ${adoption.title}`.slice(0, 200);
    insertTask.run(
      adoption.taskId,
      adoption.scope.kind,
      adoption.scope.kind === "user" ? identity.userId : null,
      adoption.scope.kind === "project" ? adoption.scope.projectId : null,
      taskTitle,
      `继续升级前由 D Code 管理的会话：${adoption.title}`,
      cwd,
      now,
      now,
    );
    insertSession.run(adoption.sessionId, adoption.taskId, adoption.title, now, now);
    const importedEntryIds = new Map<string, string>();
    for (const entry of adoption.entries) {
      const entryId = `legacy-entry-${createHash("sha256")
        .update(`${adoption.sourceSessionId}\0${entry.sourceEntryId}`)
        .digest("hex")
        .slice(0, 32)}`;
      importedEntryIds.set(entry.sourceEntryId, entryId);
      insertEntry.run(
        entryId,
        adoption.sessionId,
        entry.sourceEntryId,
        entry.sourceParentEntryId ?? null,
        entry.sourceOrdinal,
        entry.sourceTimestamp ?? null,
        entry.messageRole,
        JSON.stringify(entry.content),
        now,
      );
    }
    for (const path of adoption.paths) {
      const pathId = `legacy-path-${createHash("sha256")
        .update(`${adoption.sourceSessionId}\0${path.sourcePathId}`)
        .digest("hex")
        .slice(0, 32)}`;
      insertPath.run(
        pathId,
        adoption.sessionId,
        path.sourcePathId,
        path.sourceLeafEntryId ?? null,
        path.title,
        path.isCurrent ? 1 : 0,
        now,
        now,
      );
      for (const [ordinal, sourceEntryId] of path.sourceEntryIds.entries()) {
        const entryId = importedEntryIds.get(sourceEntryId);
        if (!entryId) throw new Error(`Missing legacy entry mapping: ${sourceEntryId}`);
        insertPathEntry.run(pathId, entryId, ordinal);
      }
    }
    insertAssignment.run(
      adoption.coordinatorAssignmentId,
      adoption.taskId,
      adoption.sessionId,
      now,
      now,
    );
    insertProvenance.run(
      `provenance-${createHash("sha256").update(adoption.sourceSessionId).digest("hex").slice(0, 32)}`,
      adoption.taskId,
      adoption.sessionId,
      adoption.sourceSessionId,
      adoption.sourcePath,
      adoption.sourceDigest,
      adoption.historicalCwd,
      JSON.stringify({
        originVersion: 1,
        migrationId: plan.id,
        conversionEvidence: adoption.conversionEvidence,
        importedPathCount: adoption.paths.length,
        importedEntryCount: adoption.entries.length,
      }),
      now,
    );
  }
  applyLegacyProductState(database, identity, plan, now);
}

function createSchema(
  database: DatabaseSync,
  identity: ProductStoreBootstrapIdentity,
  now: string,
  migrationPlan?: LegacyMigrationPlan,
): void {
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    BEGIN IMMEDIATE;

    CREATE TABLE dcode_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      product_version TEXT NOT NULL
    ) STRICT;

    CREATE TABLE local_users (
      id TEXT PRIMARY KEY,
      home_directory TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES local_users(id),
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
      directory TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('coordinator', 'explore', 'worker', 'verifier', 'custom')),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
      role_contract TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      builtin INTEGER NOT NULL CHECK(builtin IN (0, 1)),
      profile_version INTEGER NOT NULL CHECK(profile_version >= 1),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('user', 'project')),
      user_id TEXT REFERENCES local_users(id),
      project_id TEXT REFERENCES projects(id),
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
      goal TEXT NOT NULL,
      acceptance_json TEXT NOT NULL CHECK(json_valid(acceptance_json)),
      cwd TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('draft', 'active', 'waiting', 'completed', 'rejected', 'archived')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (scope_kind = 'user' AND user_id IS NOT NULL AND project_id IS NULL)
        OR
        (scope_kind = 'project' AND user_id IS NULL AND project_id IS NOT NULL)
      )
    ) STRICT;

    ${TASK_CONTEXT_SCHEMA_SQL}

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('coordination', 'child', 'standard')),
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
      runtime_adapter TEXT NOT NULL CHECK(runtime_adapter IN ('pi')),
      lineage_status TEXT NOT NULL CHECK(lineage_status IN ('native', 'unknown')),
      state TEXT NOT NULL CHECK(state IN ('idle', 'active', 'waiting', 'completed', 'failed', 'archived')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX one_coordination_session_per_task
      ON sessions(task_id) WHERE kind = 'coordination';

    CREATE TABLE session_paths (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      parent_path_id TEXT REFERENCES session_paths(id) ON DELETE SET NULL,
      source_path_id TEXT,
      source_leaf_entry_id TEXT,
      title TEXT NOT NULL,
      is_current INTEGER NOT NULL CHECK(is_current IN (0, 1)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, source_path_id)
    ) STRICT;
    CREATE UNIQUE INDEX one_current_path_per_session
      ON session_paths(session_id) WHERE is_current = 1;

    CREATE TABLE session_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      parent_entry_id TEXT REFERENCES session_entries(id) DEFERRABLE INITIALLY DEFERRED,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('native', 'pi_import', 'legacy_adoption')),
      lineage_status TEXT NOT NULL CHECK(lineage_status IN ('native', 'unknown')),
      source_entry_id TEXT,
      source_parent_entry_id TEXT,
      source_ordinal INTEGER,
      source_timestamp TEXT,
      message_role TEXT NOT NULL CHECK(message_role IN ('user', 'assistant', 'toolResult', 'other')),
      content_json TEXT NOT NULL CHECK(json_valid(content_json)),
      created_at TEXT NOT NULL,
      UNIQUE(session_id, source_kind, source_entry_id)
    ) STRICT;
    CREATE INDEX session_entries_order
      ON session_entries(session_id, source_ordinal, id);

    CREATE TABLE session_path_entries (
      path_id TEXT NOT NULL REFERENCES session_paths(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL REFERENCES session_entries(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      PRIMARY KEY(path_id, entry_id),
      UNIQUE(path_id, ordinal)
    ) STRICT;

    CREATE TABLE coordinator_assignments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE task_plans (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('draft', 'active', 'paused', 'completed', 'superseded')),
      document_json TEXT NOT NULL CHECK(json_valid(document_json)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE task_work_items (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      title TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'in_progress', 'completed', 'blocked', 'cancelled')),
      owner_assignment_id TEXT REFERENCES agent_assignments(id) DEFERRABLE INITIALLY DEFERRED,
      details_json TEXT NOT NULL CHECK(json_valid(details_json)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, ordinal)
    ) STRICT;

    CREATE TABLE raw_inputs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      submitted_text TEXT NOT NULL,
      attachment_refs_json TEXT NOT NULL CHECK(json_valid(attachment_refs_json)),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('user_submit', 'edit_and_rerun', 'continue_path')),
      created_at TEXT NOT NULL,
      UNIQUE(session_id, ordinal)
    ) STRICT;

    CREATE TABLE effective_inputs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      raw_input_id TEXT NOT NULL REFERENCES raw_inputs(id),
      conversion_revision INTEGER NOT NULL CHECK(conversion_revision >= 1),
      effective_content_json TEXT NOT NULL CHECK(json_valid(effective_content_json)),
      context_projection_json TEXT NOT NULL CHECK(json_valid(context_projection_json)),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE runtime_environments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      runtime_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      workspace_access TEXT NOT NULL CHECK(workspace_access IN ('sharedReadOnly', 'exclusiveWrite')),
      model_provider TEXT,
      model_id TEXT,
      environment_json TEXT NOT NULL CHECK(json_valid(environment_json)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      UNIQUE(runtime_id, revision)
    ) STRICT;

    CREATE TABLE active_tool_sets (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      digest TEXT NOT NULL,
      tools_json TEXT NOT NULL CHECK(json_valid(tools_json)),
      writable INTEGER NOT NULL CHECK(writable IN (0, 1)),
      created_at TEXT NOT NULL,
      UNIQUE(session_id, revision)
    ) STRICT;

    CREATE TABLE session_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      runtime_id TEXT NOT NULL,
      agent_run_id TEXT REFERENCES agent_runs(id) DEFERRABLE INITIALLY DEFERRED,
      user_entry_id TEXT REFERENCES session_entries(id),
      assistant_entry_id TEXT REFERENCES session_entries(id),
      effective_input_id TEXT REFERENCES effective_inputs(id),
      runtime_environment_id TEXT REFERENCES runtime_environments(id),
      active_tool_set_id TEXT REFERENCES active_tool_sets(id),
      status TEXT NOT NULL CHECK(status IN ('prepared', 'running', 'waiting', 'completed', 'failed', 'aborted', 'interrupted', 'unknown')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX one_active_run_per_session
      ON session_runs(session_id)
      WHERE status IN ('prepared', 'running', 'waiting');

    CREATE TABLE prompt_receipts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      session_run_id TEXT NOT NULL UNIQUE REFERENCES session_runs(id) ON DELETE CASCADE,
      effective_input_id TEXT NOT NULL REFERENCES effective_inputs(id),
      runtime_environment_id TEXT NOT NULL REFERENCES runtime_environments(id),
      active_tool_set_id TEXT NOT NULL REFERENCES active_tool_sets(id),
      system_prompt_digest TEXT NOT NULL,
      identity_revision TEXT NOT NULL,
      role_revision TEXT NOT NULL,
      source_receipts_json TEXT NOT NULL CHECK(json_valid(source_receipts_json)),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE team_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      coordinator_agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) DEFERRABLE INITIALLY DEFERRED,
      status TEXT NOT NULL CHECK(status IN ('prepared', 'active', 'waiting', 'completed', 'failed', 'aborted', 'interrupted', 'unknown')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    ) STRICT;
    CREATE UNIQUE INDEX one_active_team_run_per_task
      ON team_runs(task_id)
      WHERE status IN ('prepared', 'active', 'waiting');

    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      team_run_id TEXT REFERENCES team_runs(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
      profile_snapshot_json TEXT NOT NULL CHECK(json_valid(profile_snapshot_json)),
      role TEXT NOT NULL,
      model_provider TEXT,
      model_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('prepared', 'running', 'waiting', 'completed', 'failed', 'aborted', 'interrupted', 'unknown')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    ) STRICT;

    CREATE TABLE agent_assignments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      team_run_id TEXT REFERENCES team_runs(id) ON DELETE CASCADE,
      agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
      assignment_kind TEXT NOT NULL CHECK(assignment_kind IN ('coordinator', 'member')),
      task_packet_json TEXT NOT NULL CHECK(json_valid(task_packet_json)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE operation_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      session_run_id TEXT REFERENCES session_runs(id) ON DELETE CASCADE,
      agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
      operation_kind TEXT NOT NULL CHECK(operation_kind IN ('provider_request', 'tool_invocation', 'external_side_effect')),
      target_identity TEXT NOT NULL,
      parameter_digest TEXT NOT NULL,
      replay_policy TEXT NOT NULL CHECK(replay_policy IN ('never', 'explicit_idempotent')),
      status TEXT NOT NULL CHECK(status IN ('prepared', 'succeeded', 'failed', 'unknown')),
      outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)),
      prepared_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE findings (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'blocking')),
      body TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json)),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE agent_requests (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      team_run_id TEXT REFERENCES team_runs(id) ON DELETE CASCADE,
      agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      session_run_id TEXT NOT NULL REFERENCES session_runs(id) ON DELETE CASCADE,
      runtime_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT NOT NULL,
      options_json TEXT NOT NULL CHECK(json_valid(options_json)),
      status TEXT NOT NULL CHECK(status IN ('open', 'answered', 'cancelled')),
      answer_json TEXT CHECK(answer_json IS NULL OR json_valid(answer_json)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX one_open_agent_request_per_agent_run
      ON agent_requests(agent_run_id)
      WHERE status = 'open';

    CREATE TABLE agent_reports (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      report_kind TEXT NOT NULL CHECK(report_kind IN ('member', 'coordinator', 'verification')),
      body_json TEXT NOT NULL CHECK(json_valid(body_json)),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      managed_path TEXT,
      external_path TEXT,
      digest TEXT,
      metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK((managed_path IS NOT NULL) OR (external_path IS NOT NULL))
    ) STRICT;

    CREATE TABLE product_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL CHECK(json_valid(value_json)),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('default', 'legacy_user_defaults', 'legacy_pi_settings', 'user')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE creation_mode_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL CHECK(json_valid(value_json)),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('default', 'legacy_user_defaults', 'user')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE recovery_intents (
      id TEXT PRIMARY KEY,
      intent_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      state TEXT NOT NULL CHECK(state IN ('pending', 'consumed', 'cancelled', 'unknown')),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('legacy_user_defaults', 'dcode')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE composer_drafts (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      draft_kind TEXT NOT NULL CHECK(draft_kind IN ('new_task', 'session_path')),
      text TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      source_ordinal INTEGER,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE session_path_selections (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      selected_path_id TEXT,
      pending_action_json TEXT CHECK(pending_action_json IS NULL OR json_valid(pending_action_json)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE session_archive_states (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      archived_at TEXT NOT NULL,
      copied_to_session_id TEXT,
      source_title TEXT NOT NULL,
      source_cwd TEXT NOT NULL,
      details_json TEXT NOT NULL CHECK(json_valid(details_json)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE session_user_states (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      pinned_at TEXT,
      hidden INTEGER NOT NULL CHECK(hidden IN (0, 1)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE legacy_session_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_run_id TEXT NOT NULL,
      lineage_status TEXT NOT NULL CHECK(lineage_status = 'unknown'),
      status TEXT NOT NULL CHECK(status IN ('completed', 'failed', 'aborted', 'interrupted', 'unknown')),
      details_json TEXT NOT NULL CHECK(json_valid(details_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, source_run_id)
    ) STRICT;

    CREATE TABLE session_attention (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      legacy_run_id TEXT REFERENCES legacy_session_runs(id) ON DELETE SET NULL,
      completion_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      presented_at TEXT,
      notified_at TEXT,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE follow_up_queues (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      active_legacy_run_id TEXT REFERENCES legacy_session_runs(id) ON DELETE SET NULL,
      path_id TEXT,
      lineage_entry_id TEXT,
      pause_reason TEXT,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE follow_up_items (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL REFERENCES follow_up_queues(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      body TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'dispatching', 'unknown')),
      prompt_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(queue_id, ordinal)
    ) STRICT;

    CREATE TABLE session_mutations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      legacy_run_id TEXT REFERENCES legacy_session_runs(id) ON DELETE SET NULL,
      source_record_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('edit', 'create')),
      file_path TEXT NOT NULL,
      additions INTEGER NOT NULL CHECK(additions >= 0),
      deletions INTEGER NOT NULL CHECK(deletions >= 0),
      first_changed_line INTEGER,
      occurred_at TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, source_record_id)
    ) STRICT;

    CREATE TABLE evidence_records (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      legacy_run_id TEXT REFERENCES legacy_session_runs(id) ON DELETE SET NULL,
      agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      source_record_id TEXT,
      evidence_kind TEXT NOT NULL,
      command_redacted TEXT,
      exit_kind TEXT,
      exit_code INTEGER,
      started_at TEXT,
      ended_at TEXT,
      cwd TEXT,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE self_evolution_runs (
      id TEXT PRIMARY KEY,
      source_run_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      document_revision INTEGER NOT NULL CHECK(document_revision >= 0),
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE self_evolution_events (
      id TEXT PRIMARY KEY,
      self_evolution_run_id TEXT NOT NULL REFERENCES self_evolution_runs(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      event_json TEXT NOT NULL CHECK(json_valid(event_json)),
      created_at TEXT NOT NULL,
      UNIQUE(self_evolution_run_id, ordinal)
    ) STRICT;

    CREATE TABLE self_evolution_recovery (
      id TEXT PRIMARY KEY,
      self_evolution_run_id TEXT REFERENCES self_evolution_runs(id) ON DELETE SET NULL,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      state TEXT NOT NULL CHECK(state IN ('pending', 'completed', 'cancelled', 'unknown')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE model_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT,
      api_kind TEXT,
      auth_mode TEXT,
      nonsecret_json TEXT NOT NULL CHECK(json_valid(nonsecret_json)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE model_catalog_entries (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      name TEXT NOT NULL,
      context_window INTEGER,
      max_tokens INTEGER,
      reasoning INTEGER NOT NULL CHECK(reasoning IN (0, 1)),
      nonsecret_json TEXT NOT NULL CHECK(json_valid(nonsecret_json)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider_id, model_id)
    ) STRICT;

    CREATE TABLE credential_references (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
      reference_kind TEXT NOT NULL CHECK(reference_kind IN ('keychain', 'environment', 'external_auth_bridge')),
      locator TEXT NOT NULL,
      configured INTEGER NOT NULL CHECK(configured IN (0, 1)),
      source_digest TEXT,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE capability_sources (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      source_kind TEXT NOT NULL,
      nonsecret_json TEXT NOT NULL CHECK(json_valid(nonsecret_json)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE capability_configurations (
      id TEXT PRIMARY KEY,
      capability_source_id TEXT NOT NULL REFERENCES capability_sources(id) ON DELETE CASCADE,
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('user', 'project')),
      user_id TEXT REFERENCES local_users(id),
      project_id TEXT REFERENCES projects(id),
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (scope_kind = 'user' AND user_id IS NOT NULL AND project_id IS NULL)
        OR
        (scope_kind = 'project' AND user_id IS NULL AND project_id IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE migration_runs (
      id TEXT PRIMARY KEY,
      source_manifest_json TEXT NOT NULL CHECK(json_valid(source_manifest_json)),
      state TEXT NOT NULL CHECK(state IN ('preparing', 'completed', 'failed')),
      source_digest TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE migration_unresolved_references (
      id TEXT PRIMARY KEY,
      migration_id TEXT NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL,
      source_identity TEXT NOT NULL,
      reason TEXT NOT NULL,
      details_json TEXT NOT NULL CHECK(json_valid(details_json)),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE session_provenance (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('native', 'pi_import', 'legacy_adoption')),
      source_session_id TEXT,
      source_path TEXT,
      source_digest TEXT,
      historical_cwd TEXT,
      lineage_status TEXT NOT NULL CHECK(lineage_status IN ('native', 'unknown')),
      details_json TEXT NOT NULL CHECK(json_valid(details_json)),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE session_runtime_bindings (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      adapter_kind TEXT NOT NULL CHECK(adapter_kind = 'pi'),
      adapter_session_id TEXT NOT NULL UNIQUE,
      adapter_session_path TEXT NOT NULL,
      cwd TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready', 'closed', 'invalid')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE mutation_receipts (
      request_id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK(json_valid(result_json)),
      store_revision INTEGER NOT NULL CHECK(store_revision >= 1),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE store_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      store_revision INTEGER NOT NULL UNIQUE CHECK(store_revision >= 1),
      kind TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      task_id TEXT,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE legacy_sources (
      id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_digest TEXT NOT NULL,
      migration_id TEXT NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('discovered', 'validated', 'promoted', 'failed')),
      details_json TEXT NOT NULL CHECK(json_valid(details_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_kind, source_path, source_digest)
    ) STRICT;

    CREATE TABLE pi_import_sources (
      id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_digest TEXT NOT NULL,
      importer_version INTEGER NOT NULL CHECK(importer_version >= 1),
      task_id TEXT REFERENCES tasks(id),
      session_id TEXT REFERENCES sessions(id),
      lineage_status TEXT NOT NULL CHECK(lineage_status = 'unknown'),
      state TEXT NOT NULL CHECK(state IN ('prepared', 'completed', 'failed', 'unknown')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_session_id, source_digest, importer_version)
    ) STRICT;

    PRAGMA application_id = ${PRODUCT_STORE_APPLICATION_ID};
    PRAGMA user_version = ${PRODUCT_STORE_SCHEMA_VERSION};
  `);

  try {
    const insertMeta = database.prepare("INSERT INTO dcode_meta(key, value) VALUES (?, ?)");
    insertMeta.run("schema_version", String(PRODUCT_STORE_SCHEMA_VERSION));
    insertMeta.run("minimum_reader_schema_version", String(PRODUCT_STORE_SCHEMA_VERSION));
    insertMeta.run("product_version", "0.0.28");
    insertMeta.run("store_revision", "0");
    insertMeta.run("current_user_id", identity.userId);
    insertMeta.run("created_at", now);
    insertMeta.run("migration_state", "complete");
    insertMeta.run("schema_fingerprint", schemaFingerprint(database));
    database.prepare(`
      INSERT INTO schema_migrations(version, applied_at, product_version)
      VALUES (?, ?, ?)
    `).run(PRODUCT_STORE_SCHEMA_VERSION, now, "0.0.28");
    database.prepare(`
      INSERT INTO local_users(id, home_directory, revision, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
    `).run(identity.userId, identity.userHome, now, now);
    const insertProfile = database.prepare(`
      INSERT INTO agent_profiles(
        id, role, name, role_contract, enabled, builtin,
        profile_version, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, 1, 1, 1, ?, ?)
    `);
    for (const profile of BUILTIN_PROFILES) {
      insertProfile.run(profile.id, profile.role, profile.name, profile.roleContract, now, now);
    }
    if (migrationPlan && migrationPlan.sourceManifest.length > 0) {
      applyLegacyMigrationPlan(database, identity, migrationPlan, now);
      insertMeta.run("migration_id", migrationPlan.id);
    }
    database.prepare(`
      INSERT OR IGNORE INTO task_context_sets(task_id, revision, created_at, updated_at)
      SELECT id, 1, ?, ? FROM tasks
    `).run(now, now);
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function assertIntegrity(database: DatabaseSync): void {
  let quickCheck: unknown;
  try {
    quickCheck = scalarPragma(database, "PRAGMA quick_check");
  } catch (error) {
    throw new ProductStoreSchemaError(
      "PRODUCT_STORE_INTEGRITY_FAILED",
      "D Code Product Store integrity check could not complete",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (quickCheck !== "ok") {
    throw new ProductStoreSchemaError(
      "PRODUCT_STORE_INTEGRITY_FAILED",
      "D Code Product Store integrity check failed",
      { quickCheck },
    );
  }
  const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyFailures.length > 0) {
    throw new ProductStoreSchemaError(
      "PRODUCT_STORE_INTEGRITY_FAILED",
      "D Code Product Store contains invalid foreign-key references",
      { foreignKeyFailures },
    );
  }
}

function validateProductStoreSchemaVersion(database: DatabaseSync, expectedSchemaVersion: number): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    PRAGMA trusted_schema = OFF;
  `);
  const applicationId = Number(scalarPragma(database, "PRAGMA application_id"));
  const schemaVersion = Number(scalarPragma(database, "PRAGMA user_version"));
  if (applicationId !== PRODUCT_STORE_APPLICATION_ID || schemaVersion !== expectedSchemaVersion) {
    throw new ProductStoreSchemaError(
      "PRODUCT_STORE_SCHEMA_UNSUPPORTED",
      "D Code cannot open this Product Store schema without a supported migration",
      {
        applicationId,
        schemaVersion,
        expectedApplicationId: PRODUCT_STORE_APPLICATION_ID,
        expectedSchemaVersion,
      },
    );
  }
  try {
    const requiredTables = [
      "dcode_meta",
      "schema_migrations",
      "local_users",
      "projects",
      "agent_profiles",
      "tasks",
      "sessions",
      "session_paths",
      "session_entries",
      "session_path_entries",
      "coordinator_assignments",
      "task_plans",
      "task_work_items",
      "raw_inputs",
      "effective_inputs",
      "runtime_environments",
      "active_tool_sets",
      "session_runs",
      "prompt_receipts",
      "team_runs",
      "agent_runs",
      "agent_assignments",
      "operation_attempts",
      "findings",
      "agent_requests",
      "agent_reports",
      "artifacts",
      "product_settings",
      "creation_mode_settings",
      "recovery_intents",
      "composer_drafts",
      "session_path_selections",
      "session_archive_states",
      "session_user_states",
      "legacy_session_runs",
      "session_attention",
      "follow_up_queues",
      "follow_up_items",
      "session_mutations",
      "evidence_records",
      "self_evolution_runs",
      "self_evolution_events",
      "self_evolution_recovery",
      "model_providers",
      "model_catalog_entries",
      "credential_references",
      "capability_sources",
      "capability_configurations",
      "migration_runs",
      "migration_unresolved_references",
      "session_provenance",
      "session_runtime_bindings",
      "mutation_receipts",
      "store_events",
      "legacy_sources",
      "pi_import_sources",
    ];
    if (expectedSchemaVersion >= 2) {
      requiredTables.push("task_context_sets", "task_context_sources");
    }
    const tables = new Set((database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all() as Array<{ name?: unknown }>).flatMap((row) => (
      typeof row.name === "string" ? [row.name] : []
    )));
    const missingTables = requiredTables.filter((table) => !tables.has(table));
    if (missingTables.length > 0) {
      throw new ProductStoreSchemaError(
        "PRODUCT_STORE_SCHEMA_INVALID",
        "D Code Product Store is missing required schema tables",
        { missingTables },
      );
    }

    const migration = database.prepare(`
      SELECT product_version FROM schema_migrations WHERE version = ?
    `).get(expectedSchemaVersion) as { product_version?: unknown } | undefined;
    const metaRows = database.prepare("SELECT key, value FROM dcode_meta").all() as Array<{
      key?: unknown;
      value?: unknown;
    }>;
    const meta = new Map<string, string>();
    for (const row of metaRows) {
      if (typeof row.key === "string" && typeof row.value === "string") meta.set(row.key, row.value);
    }
    const requiredMetaKeys = [
      "schema_version",
      "minimum_reader_schema_version",
      "product_version",
      "store_revision",
      "current_user_id",
      "created_at",
      "migration_state",
      "schema_fingerprint",
    ];
    const missingMetaKeys = requiredMetaKeys.filter((key) => !meta.has(key));
    const storeRevision = meta.get("store_revision") ?? "";
    if (
      !migration
      || migration.product_version !== "0.0.28"
      || meta.get("schema_version") !== String(expectedSchemaVersion)
      || meta.get("minimum_reader_schema_version") !== String(expectedSchemaVersion)
      || meta.get("product_version") !== "0.0.28"
      || meta.get("migration_state") !== "complete"
      || meta.get("schema_fingerprint") !== schemaFingerprint(database)
      || !/^\d+$/.test(storeRevision)
      || !Number.isSafeInteger(Number(storeRevision))
      || missingMetaKeys.length > 0
    ) {
      throw new ProductStoreSchemaError(
        "PRODUCT_STORE_SCHEMA_INVALID",
        "D Code Product Store schema metadata is incomplete or invalid",
        { schemaVersion, missingMetaKeys },
      );
    }

    const currentUserId = meta.get("current_user_id") as string;
    const currentUser = database.prepare(`
      SELECT id, home_directory, revision FROM local_users WHERE id = ?
    `).get(currentUserId) as { id?: unknown; home_directory?: unknown; revision?: unknown } | undefined;
    if (
      !currentUser
      || currentUser.id !== currentUserId
      || typeof currentUser.home_directory !== "string"
      || currentUser.home_directory.length === 0
      || typeof currentUser.revision !== "number"
      || currentUser.revision < 1
    ) {
      throw new ProductStoreSchemaError(
        "PRODUCT_STORE_SCHEMA_INVALID",
        "D Code Product Store current user metadata is invalid",
        { currentUserId },
      );
    }

    const builtinRows = database.prepare(`
      SELECT id FROM agent_profiles
      WHERE id IN ('builtin-coordinator', 'builtin-explore', 'builtin-worker', 'builtin-verifier')
        AND builtin = 1
    `).all() as Array<{ id?: unknown }>;
    if (new Set(builtinRows.map((row) => row.id)).size !== 4) {
      throw new ProductStoreSchemaError(
        "PRODUCT_STORE_SCHEMA_INVALID",
        "D Code Product Store built-in Agent Profiles are incomplete",
      );
    }

    if (expectedSchemaVersion >= 2) {
      const missingContextSet = database.prepare(`
        SELECT t.id
        FROM tasks t
        LEFT JOIN task_context_sets c ON c.task_id = t.id
        WHERE c.task_id IS NULL
        LIMIT 1
      `).get() as { id?: unknown } | undefined;
      const orphanContextSource = database.prepare(`
        SELECT s.id
        FROM task_context_sources s
        LEFT JOIN task_context_sets c ON c.task_id = s.task_id
        WHERE c.task_id IS NULL
        LIMIT 1
      `).get() as { id?: unknown } | undefined;
      if (missingContextSet || orphanContextSource) {
        throw new ProductStoreSchemaError(
          "PRODUCT_STORE_SCHEMA_INVALID",
          "D Code Product Store Task Context Selection facts are incomplete",
          {
            ...(typeof missingContextSet?.id === "string" ? { missingTaskId: missingContextSet.id } : {}),
            ...(typeof orphanContextSource?.id === "string" ? { orphanContextSourceId: orphanContextSource.id } : {}),
          },
        );
      }
    }

    const invalidJSONChecks = [
      ["tasks", "acceptance_json"],
      ["session_entries", "content_json"],
      ["task_plans", "document_json"],
      ["task_work_items", "details_json"],
      ["raw_inputs", "attachment_refs_json"],
      ["effective_inputs", "effective_content_json"],
      ["effective_inputs", "context_projection_json"],
      ["runtime_environments", "environment_json"],
      ["active_tool_sets", "tools_json"],
      ["prompt_receipts", "source_receipts_json"],
      ["agent_runs", "profile_snapshot_json"],
      ["agent_assignments", "task_packet_json"],
      ["findings", "evidence_refs_json"],
      ["agent_requests", "options_json"],
      ["agent_reports", "body_json"],
      ["artifacts", "metadata_json"],
      ["product_settings", "value_json"],
      ["creation_mode_settings", "value_json"],
      ["recovery_intents", "payload_json"],
      ["composer_drafts", "payload_json"],
      ["session_archive_states", "details_json"],
      ["legacy_session_runs", "details_json"],
      ["evidence_records", "payload_json"],
      ["self_evolution_runs", "payload_json"],
      ["self_evolution_events", "event_json"],
      ["self_evolution_recovery", "payload_json"],
      ["model_providers", "nonsecret_json"],
      ["model_catalog_entries", "nonsecret_json"],
      ["capability_sources", "nonsecret_json"],
      ["capability_configurations", "configuration_json"],
      ["migration_runs", "source_manifest_json"],
      ["migration_unresolved_references", "details_json"],
      ["session_provenance", "details_json"],
      ["mutation_receipts", "result_json"],
      ["store_events", "payload_json"],
      ["legacy_sources", "details_json"],
    ] as const;
    for (const [table, column] of invalidJSONChecks) {
      const invalid = database.prepare(`
        SELECT 1 AS invalid FROM ${table} WHERE json_valid(${column}) = 0 LIMIT 1
      `).get();
      if (invalid) {
        throw new ProductStoreSchemaError(
          "PRODUCT_STORE_SCHEMA_INVALID",
          "D Code Product Store contains invalid JSON facts",
          { table, column },
        );
      }
    }
  } catch (error) {
    if (error instanceof ProductStoreSchemaError) throw error;
    throw new ProductStoreSchemaError(
      "PRODUCT_STORE_SCHEMA_INVALID",
      "D Code Product Store schema validation could not complete",
      { schemaVersion, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  assertIntegrity(database);
}

export function validateProductStoreSchema(database: DatabaseSync): void {
  validateProductStoreSchemaVersion(database, PRODUCT_STORE_SCHEMA_VERSION);
}

export function configureWritableProductStore(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    PRAGMA trusted_schema = OFF;
  `);
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function publishMigrationBackup(path: string, contents: Uint8Array): Promise<void> {
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (!existing.equals(contents)) {
      throw new ProductStoreSchemaError(
        "PRODUCT_STORE_SCHEMA_INVALID",
        "A migration backup path already contains different bytes",
        { path },
      );
    }
  }
}

async function writeMigrationBackups(
  layout: DCodeDataRootLayout,
  plan: LegacyMigrationPlan,
): Promise<void> {
  const migrationDirectory = join(layout.migrationsDirectory, plan.id);
  const sourcesDirectory = join(migrationDirectory, "sources");
  await prepareManagedDCodeDirectory(migrationDirectory);
  await prepareManagedDCodeDirectory(sourcesDirectory);
  await publishMigrationBackup(
    join(migrationDirectory, "manifest.json"),
    Buffer.from(`${JSON.stringify({
      migrationId: plan.id,
      sourceDigest: plan.sourceDigest,
      sources: plan.sourceManifest,
    }, null, 2)}\n`),
  );
  let backupOrdinal = 0;
  for (const source of plan.sources) {
    if (source.containsCredentialMaterial) continue;
    const safeKind = source.kind.replace(/[^A-Za-z0-9_-]/g, "-");
    await publishMigrationBackup(
      join(sourcesDirectory, `${String(backupOrdinal).padStart(3, "0")}-${safeKind}.json`),
      source.sourceBytes,
    );
    backupOrdinal += 1;
  }
}

async function writeSchemaPromotionBackup(
  database: DatabaseSync,
  layout: DCodeDataRootLayout,
  fromVersion: number,
  toVersion: number,
): Promise<{ migrationId: string; digest: string }> {
  const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
    busy?: unknown;
    log?: unknown;
    checkpointed?: unknown;
  } | undefined;
  if (
    !checkpoint
    || checkpoint.busy !== 0
    || typeof checkpoint.log !== "number"
    || typeof checkpoint.checkpointed !== "number"
    || checkpoint.log !== checkpoint.checkpointed
  ) {
    throw new ProductStoreSchemaError(
      "PRODUCT_STORE_SCHEMA_INVALID",
      "D Code could not checkpoint every Product Store WAL page before schema migration backup",
      { checkpoint },
    );
  }
  await syncFile(layout.productStorePath);
  const bytes = await readFile(layout.productStorePath);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const migrationId = `schema-v${fromVersion}-to-v${toVersion}-${digest.slice("sha256:".length, "sha256:".length + 16)}`;
  const migrationDirectory = join(layout.migrationsDirectory, migrationId);
  await prepareManagedDCodeDirectory(migrationDirectory);
  await publishMigrationBackup(join(migrationDirectory, "product-store-before.sqlite3"), bytes);
  await publishMigrationBackup(
    join(migrationDirectory, "manifest.json"),
    Buffer.from(`${JSON.stringify({
      migrationId,
      fromSchemaVersion: fromVersion,
      toSchemaVersion: toVersion,
      sourceDigest: digest,
    }, null, 2)}\n`),
  );
  await syncDirectory(migrationDirectory);
  await syncDirectory(layout.migrationsDirectory);
  return { migrationId, digest };
}

export async function migrateProductStoreSchemaIfNeeded(
  database: DatabaseSync,
  layout: DCodeDataRootLayout,
  now = new Date().toISOString(),
): Promise<void> {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    PRAGMA trusted_schema = OFF;
  `);
  const applicationId = Number(scalarPragma(database, "PRAGMA application_id"));
  const schemaVersion = Number(scalarPragma(database, "PRAGMA user_version"));
  if (applicationId !== PRODUCT_STORE_APPLICATION_ID) {
    throw new ProductStoreSchemaError(
      "PRODUCT_STORE_SCHEMA_UNSUPPORTED",
      "D Code cannot migrate a Product Store with an unknown application identity",
      { applicationId, expectedApplicationId: PRODUCT_STORE_APPLICATION_ID, schemaVersion },
    );
  }
  if (schemaVersion === PRODUCT_STORE_SCHEMA_VERSION) return;
  if (schemaVersion !== 1) {
    throw new ProductStoreSchemaError(
      "PRODUCT_STORE_SCHEMA_UNSUPPORTED",
      "D Code has no safe migration path for this Product Store schema",
      { schemaVersion, expectedSchemaVersion: PRODUCT_STORE_SCHEMA_VERSION },
    );
  }

  validateProductStoreSchemaVersion(database, 1);
  const backup = await writeSchemaPromotionBackup(database, layout, 1, PRODUCT_STORE_SCHEMA_VERSION);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(TASK_CONTEXT_SCHEMA_SQL);
    database.prepare(`
      INSERT INTO task_context_sets(task_id, revision, created_at, updated_at)
      SELECT id, 1, ?, ? FROM tasks
    `).run(now, now);
    const currentRevision = Number((database.prepare(
      "SELECT value FROM dcode_meta WHERE key = 'store_revision'",
    ).get() as { value?: unknown } | undefined)?.value);
    if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
      throw new ProductStoreSchemaError(
        "PRODUCT_STORE_SCHEMA_INVALID",
        "D Code Product Store has an invalid store revision before schema migration",
      );
    }
    const nextStoreRevision = currentRevision + 1;
    database.prepare(`
      INSERT INTO schema_migrations(version, applied_at, product_version)
      VALUES (?, ?, '0.0.28')
    `).run(PRODUCT_STORE_SCHEMA_VERSION, now);
    database.prepare("UPDATE dcode_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(PRODUCT_STORE_SCHEMA_VERSION));
    database.prepare("UPDATE dcode_meta SET value = ? WHERE key = 'minimum_reader_schema_version'")
      .run(String(PRODUCT_STORE_SCHEMA_VERSION));
    database.prepare("UPDATE dcode_meta SET value = 'complete' WHERE key = 'migration_state'").run();
    database.prepare("UPDATE dcode_meta SET value = ? WHERE key = 'store_revision'")
      .run(String(nextStoreRevision));
    database.prepare("UPDATE dcode_meta SET value = ? WHERE key = 'schema_fingerprint'")
      .run(schemaFingerprint(database));
    database.exec(`PRAGMA user_version = ${PRODUCT_STORE_SCHEMA_VERSION}`);
    database.prepare(`
      INSERT INTO store_events(
        event_id, store_revision, kind, entity_kind, entity_id,
        task_id, payload_json, created_at
      ) VALUES (?, ?, 'schema.promoted', 'productStore', 'product-store', NULL, ?, ?)
    `).run(
      randomUUID(),
      nextStoreRevision,
      JSON.stringify({
        migrationId: backup.migrationId,
        fromSchemaVersion: schemaVersion,
        toSchemaVersion: PRODUCT_STORE_SCHEMA_VERSION,
        sourceDigest: backup.digest,
      }),
      now,
    );
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
  validateProductStoreSchema(database);
}

export async function initializeProductStoreAtomically(
  layout: DCodeDataRootLayout,
  identity: ProductStoreBootstrapIdentity,
  now = new Date().toISOString(),
  migrationPlan?: LegacyMigrationPlan,
): Promise<boolean> {
  if (await exists(layout.productStorePath)) return false;
  await mkdir(layout.root, { recursive: true, mode: 0o700 });
  if (migrationPlan && migrationPlan.sourceManifest.length > 0) {
    await writeMigrationBackups(layout, migrationPlan);
  }
  const pendingPath = join(
    dirname(layout.productStorePath),
    `.${basename(layout.productStorePath)}-${randomUUID()}.pending`,
  );
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(pendingPath);
    createSchema(database, identity, now, migrationPlan);
    validateProductStoreSchema(database);
    database.close();
    database = undefined;
    await chmod(pendingPath, 0o600);
    await syncFile(pendingPath);
    if (migrationPlan && migrationPlan.sourceManifest.length > 0) {
      await verifyLegacyMigrationSources(migrationPlan);
    }
    try {
      await link(pendingPath, layout.productStorePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    await syncDirectory(layout.root);
    return true;
  } finally {
    try {
      database?.close();
    } finally {
      await unlink(pendingPath).catch(() => undefined);
    }
  }
}
