import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { prepareDCodeManagedSessionAdoption } from "./pi-session-import.js";
import { ModelProvidersStore } from "./model-providers.js";
import type { ImportedPiSessionEntryInput, ImportedPiSessionPathInput } from "./product-store.js";
import { SessionReader } from "./session-reader.js";

export type LegacyStoreKind =
  | "projects"
  | "sessionDrafts"
  | "sessionArchives"
  | "sessionPins"
  | "sessionChanges"
  | "verificationEvidence"
  | "followUpQueues"
  | "activityAttention"
  | "selfEvolution"
  | "disabledPackages"
  | "piSettings"
  | "piModels"
  | "userDefaults";

export class LegacyMigrationError extends Error {
  constructor(
    readonly code:
      | "LEGACY_SOURCE_INVALID"
      | "LEGACY_SOURCE_CHANGED"
      | "LEGACY_PROJECT_CONFLICT"
      | "LEGACY_SESSION_SCOPE_CONFLICT",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "LegacyMigrationError";
  }
}

export interface LegacySourceManifestEntry {
  kind: LegacyStoreKind | "dcodeSession";
  path: string;
  size: number;
  modifiedAt: string;
  digest: string;
  containsCredentialMaterial: boolean;
}

export interface LegacySourceSnapshot extends LegacySourceManifestEntry {
  document: unknown;
  sourceBytes: Uint8Array;
}

export interface LegacyProjectSeed {
  id: string;
  title: string;
  directory: string;
  sourceProjectId: string;
  sourceOrdinal: number;
}

export interface LegacySessionAdoptionSeed {
  sourceSessionId: string;
  sourcePath: string;
  sourceDigest: string;
  title: string;
  historicalCwd: string;
  scope: { kind: "user" } | { kind: "project"; projectId: string };
  taskId: string;
  sessionId: string;
  coordinatorAssignmentId: string;
  entries: ImportedPiSessionEntryInput[];
  paths: ImportedPiSessionPathInput[];
  conversionEvidence: Record<string, unknown>;
}

export interface LegacyMigrationPlan {
  id: string;
  sourceDigest: string;
  sourceManifest: LegacySourceManifestEntry[];
  sources: LegacySourceSnapshot[];
  projects: LegacyProjectSeed[];
  adoptedSessions: LegacySessionAdoptionSeed[];
  userDefaults?: Record<string, unknown>;
}

export interface LegacyMigrationOptions {
  userHome: string;
  agentDir: string;
  sessionsDirectory: string;
  applicationSupportDirectory?: string;
  userDefaults?: Record<string, unknown>;
  sourcePaths?: Partial<Record<LegacyStoreKind, string>>;
}

interface LegacyFileDefinition {
  kind: LegacyStoreKind;
  path: string;
  maximumBytes: number;
  containsCredentialMaterial: boolean;
}

const DEFAULT_MAXIMUM_BYTES = 16 * 1024 * 1024;
const SELF_EVOLUTION_MAXIMUM_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(contents: Uint8Array): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function aggregateDigest(entries: readonly LegacySourceManifestEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) => (
    left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path)
  ))) {
    hash.update(entry.kind);
    hash.update("\0");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.digest);
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

function deterministicId(prefix: string, identity: string): string {
  return `${prefix}-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function sameFileVersion(
  left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint },
  right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

async function readStableSource(definition: LegacyFileDefinition): Promise<LegacySourceSnapshot | undefined> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(definition.path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new LegacyMigrationError(
      "LEGACY_SOURCE_INVALID",
      "Legacy D Code sources must be regular files",
      { kind: definition.kind, path: definition.path },
    );
  }
  if (before.size > BigInt(definition.maximumBytes)) {
    throw new LegacyMigrationError(
      "LEGACY_SOURCE_INVALID",
      "Legacy D Code source exceeds its migration size limit",
      { kind: definition.kind, path: definition.path, size: String(before.size) },
    );
  }
  const sourceBytes = await readFile(definition.path);
  const after = await lstat(definition.path, { bigint: true });
  if (!sameFileVersion(before, after)) {
    throw new LegacyMigrationError(
      "LEGACY_SOURCE_CHANGED",
      "Legacy D Code source changed while the migration snapshot was read",
      { kind: definition.kind, path: definition.path },
    );
  }
  let document: unknown;
  if (definition.kind === "piModels") {
    const result = await new ModelProvidersStore(definition.path).list();
    if (result.parseError) {
      throw new LegacyMigrationError(
        "LEGACY_SOURCE_INVALID",
        "Pi models.json failed ModelConfig validation",
        { kind: definition.kind, path: definition.path, cause: result.parseError },
      );
    }
    document = { providers: result.providers };
  } else {
    try {
      document = JSON.parse(sourceBytes.toString("utf8"));
    } catch (error) {
      throw new LegacyMigrationError(
        "LEGACY_SOURCE_INVALID",
        "Legacy D Code source is not valid JSON",
        { kind: definition.kind, path: definition.path, cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }
  validateLegacyDocument(definition.kind, document, definition.path);
  return {
    kind: definition.kind,
    path: definition.path,
    size: sourceBytes.byteLength,
    modifiedAt: new Date(Number(after.mtimeNs / 1_000_000n)).toISOString(),
    digest: digest(sourceBytes),
    containsCredentialMaterial: definition.containsCredentialMaterial,
    document,
    sourceBytes,
  };
}

function requireVersion(document: unknown, expected: readonly number[], kind: LegacyStoreKind, path: string): Record<string, unknown> {
  if (!isRecord(document) || typeof document.version !== "number" || !expected.includes(document.version)) {
    throw new LegacyMigrationError(
      "LEGACY_SOURCE_INVALID",
      "Legacy D Code source has an unsupported document version",
      { kind, path, expected, received: isRecord(document) ? document.version : undefined },
    );
  }
  return document;
}

function requireArray(record: Record<string, unknown>, key: string, kind: LegacyStoreKind, path: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new LegacyMigrationError(
      "LEGACY_SOURCE_INVALID",
      `Legacy D Code source requires an object-array field: ${key}`,
      { kind, path },
    );
  }
  return value;
}

function validateLegacyDocument(kind: LegacyStoreKind, document: unknown, path: string): void {
  if (kind === "userDefaults") {
    if (!isRecord(document)) {
      throw new LegacyMigrationError("LEGACY_SOURCE_INVALID", "D Code UserDefaults snapshot must be an object", { path });
    }
    return;
  }
  if (kind === "disabledPackages") {
    if (!Array.isArray(document) || document.some((item) => (
      !(typeof item === "string" && item.trim())
      && !(isRecord(item) && typeof item.source === "string" && item.source.trim())
    ))) {
      throw new LegacyMigrationError("LEGACY_SOURCE_INVALID", "Disabled package source is invalid", { kind, path });
    }
    return;
  }
  if (kind === "piSettings" || kind === "piModels") {
    if (!isRecord(document)) {
      throw new LegacyMigrationError("LEGACY_SOURCE_INVALID", "Pi configuration source must be an object", { kind, path });
    }
    return;
  }
  if (kind === "projects") {
    const record = requireVersion(document, [1, 2], kind, path);
    requireArray(record, "projects", kind, path);
    return;
  }
  const record = requireVersion(document, [1], kind, path);
  switch (kind) {
    case "sessionDrafts":
      requireArray(record, "records", kind, path);
      if (!isRecord(record.activeTargets)) {
        throw new LegacyMigrationError("LEGACY_SOURCE_INVALID", "Draft activeTargets must be an object", { path });
      }
      return;
    case "sessionArchives":
    case "sessionPins":
    case "sessionChanges":
    case "verificationEvidence":
    case "activityAttention":
      requireArray(record, "records", kind, path);
      return;
    case "followUpQueues":
      requireArray(record, "queues", kind, path);
      return;
    case "selfEvolution":
      requireArray(record, "runs", kind, path);
      if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) {
        throw new LegacyMigrationError("LEGACY_SOURCE_INVALID", "Self-evolution revision is invalid", { path });
      }
      return;
    default:
      return;
  }
}

function sourceDefinitions(options: LegacyMigrationOptions): LegacyFileDefinition[] {
  const appSupport = options.applicationSupportDirectory
    ?? join(options.userHome, "Library", "Application Support", "D Code");
  return [
    ["projects", join(appSupport, "projects-v1.json"), DEFAULT_MAXIMUM_BYTES, false],
    ["sessionDrafts", join(appSupport, "session-drafts-v1.json"), DEFAULT_MAXIMUM_BYTES, false],
    ["sessionArchives", join(appSupport, "session-archives-v1.json"), DEFAULT_MAXIMUM_BYTES, false],
    ["sessionPins", join(appSupport, "session-pins-v1.json"), DEFAULT_MAXIMUM_BYTES, false],
    ["sessionChanges", join(appSupport, "session-changes-v1.json"), DEFAULT_MAXIMUM_BYTES, false],
    ["verificationEvidence", join(appSupport, "verification-evidence-v1.json"), DEFAULT_MAXIMUM_BYTES, true],
    ["followUpQueues", join(appSupport, "follow-up-queues-v1.json"), DEFAULT_MAXIMUM_BYTES, false],
    ["activityAttention", join(appSupport, "activity-attention-v1.json"), DEFAULT_MAXIMUM_BYTES, false],
    ["selfEvolution", join(appSupport, "self-evolution-runs-v1.json"), SELF_EVOLUTION_MAXIMUM_BYTES, false],
    ["disabledPackages", join(options.agentDir, "pi-dcode", "disabled-packages.json"), DEFAULT_MAXIMUM_BYTES, false],
    ["piSettings", join(options.agentDir, "settings.json"), DEFAULT_MAXIMUM_BYTES, false],
    ["piModels", join(options.agentDir, "models.json"), DEFAULT_MAXIMUM_BYTES, true],
  ].map(([kind, path, maximumBytes, containsCredentialMaterial]) => ({
    kind: kind as LegacyStoreKind,
    path: options.sourcePaths?.[kind as LegacyStoreKind] ?? path as string,
    maximumBytes: maximumBytes as number,
    containsCredentialMaterial: containsCredentialMaterial as boolean,
  }));
}

async function canonicalHistoricalDirectory(path: string): Promise<string> {
  if (!path.startsWith("/")) {
    throw new LegacyMigrationError("LEGACY_SOURCE_INVALID", "Legacy Project directory must be absolute", { path });
  }
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function projectSeeds(source: LegacySourceSnapshot | undefined): Promise<LegacyProjectSeed[]> {
  if (!source) return [];
  const document = source.document as Record<string, unknown>;
  const version = document.version as number;
  const projects = document.projects as unknown[];
  const seeds: LegacyProjectSeed[] = [];
  for (const [projectOrdinal, value] of projects.entries()) {
    if (
      !isRecord(value)
      || typeof value.id !== "string"
      || typeof value.name !== "string"
      || !value.name.trim()
      || value.name.length > 200
    ) {
      throw new LegacyMigrationError("LEGACY_SOURCE_INVALID", "Legacy Project record is invalid", {
        path: source.path,
        projectOrdinal,
      });
    }
    const directories: string[] = [];
    if (version === 2) {
      if (!isRecord(value.directory) || typeof value.directory.path !== "string") {
        throw new LegacyMigrationError("LEGACY_SOURCE_INVALID", "Legacy Project v2 directory is invalid", {
          projectId: value.id,
        });
      }
      directories.push(value.directory.path);
    } else {
      if (!Array.isArray(value.sourceFolders) || value.sourceFolders.length === 0) {
        throw new LegacyMigrationError("LEGACY_SOURCE_INVALID", "Legacy Project v1 requires source folders", {
          projectId: value.id,
        });
      }
      for (const folder of value.sourceFolders) {
        if (!isRecord(folder) || typeof folder.path !== "string") {
          throw new LegacyMigrationError("LEGACY_SOURCE_INVALID", "Legacy Project v1 source folder is invalid", {
            projectId: value.id,
          });
        }
        directories.push(folder.path);
      }
    }
    for (const [directoryOrdinal, path] of directories.entries()) {
      const directory = await canonicalHistoricalDirectory(path);
      seeds.push({
        id: directoryOrdinal === 0
          ? value.id
          : deterministicId("legacy-project", `${value.id}\0${directory}`),
        title: directoryOrdinal === 0 ? value.name : `${value.name} ${directoryOrdinal + 1}`,
        directory,
        sourceProjectId: value.id,
        sourceOrdinal: projectOrdinal * 10_000 + directoryOrdinal,
      });
    }
  }
  const ids = new Set<string>();
  const directories = new Set<string>();
  for (const seed of seeds) {
    if (ids.has(seed.id) || directories.has(seed.directory)) {
      throw new LegacyMigrationError(
        "LEGACY_PROJECT_CONFLICT",
        "Legacy Projects contain duplicate identities or directories",
        { projectId: seed.id, directory: seed.directory },
      );
    }
    ids.add(seed.id);
    directories.add(seed.directory);
  }
  return seeds;
}

async function adoptionSeeds(
  reader: SessionReader,
  projects: readonly LegacyProjectSeed[],
): Promise<{ seeds: LegacySessionAdoptionSeed[]; manifest: LegacySourceManifestEntry[] }> {
  const summaries = await reader.list({ origin: "dcode" });
  const seeds: LegacySessionAdoptionSeed[] = [];
  const manifest: LegacySourceManifestEntry[] = [];
  for (const summary of summaries) {
    const prepared = await prepareDCodeManagedSessionAdoption(reader, summary.id);
    const canonicalCwd = await canonicalHistoricalDirectory(prepared.preview.cwd);
    const matchingProjects = projects.filter((project) => project.directory === canonicalCwd);
    if (matchingProjects.length > 1) {
      throw new LegacyMigrationError(
        "LEGACY_SESSION_SCOPE_CONFLICT",
        "A D Code-managed Pi Session matches more than one legacy Project",
        { sourceSessionId: summary.id, cwd: canonicalCwd },
      );
    }
    const taskId = deterministicId("legacy-task", summary.id);
    const sessionId = deterministicId("legacy-session", summary.id);
    seeds.push({
      sourceSessionId: summary.id,
      sourcePath: prepared.preview.sourcePath,
      sourceDigest: prepared.preview.sourceDigest,
      title: prepared.preview.title,
      historicalCwd: canonicalCwd,
      scope: matchingProjects[0]
        ? { kind: "project", projectId: matchingProjects[0].id }
        : { kind: "user" },
      taskId,
      sessionId,
      coordinatorAssignmentId: deterministicId("legacy-coordinator", summary.id),
      entries: prepared.entries,
      paths: prepared.paths,
      conversionEvidence: prepared.conversionEvidence,
    });
    const metadata = await lstat(prepared.preview.sourcePath, { bigint: true });
    manifest.push({
      kind: "dcodeSession",
      path: prepared.preview.sourcePath,
      size: Number(metadata.size),
      modifiedAt: new Date(Number(metadata.mtimeNs / 1_000_000n)).toISOString(),
      digest: prepared.preview.sourceDigest,
      containsCredentialMaterial: false,
    });
  }
  return { seeds, manifest };
}

function validateUserDefaults(input: Record<string, unknown>): Record<string, unknown> {
  const validators: Record<string, (value: unknown) => boolean> = {
    "dcode.appearance": (value) => value === "system" || value === "light" || value === "dark",
    "dcode.appearance.fontScale": (value) => value === "compact" || value === "standard" || value === "large",
    "dcode.sidebar.userHidden": (value) => typeof value === "boolean",
    "dcode.inspector.userHidden": (value) => typeof value === "boolean",
    "dcode.sidebar.width": (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
    "dcode.inspector.width": (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
    "dcode.notifications.completionEnabled": (value) => typeof value === "boolean",
    "dcode.selfBuildSourceRoot": (value) => typeof value === "string" && isAbsolute(value),
    "dcode.selfBuildRestart": (value) => typeof value === "boolean",
    "dcode.selfBuildRestartKind": (value) => (
      value === "ordinary" || value === "self-evolution" || value === "self-evolution-rollback"
    ),
    "dcode.selfBuildPendingSessionId": (value) => typeof value === "string",
    "dcode.selfEvolutionPendingRunId": (value) => typeof value === "string",
  };
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    const validator = validators[key];
    if (!validator) continue;
    if (!validator(input[key])) {
      throw new LegacyMigrationError(
        "LEGACY_SOURCE_INVALID",
        "D Code UserDefaults snapshot contains an invalid value",
        { key, valueType: typeof input[key] },
      );
    }
    result[key] = input[key];
  }
  return result;
}

export async function buildLegacyMigrationPlan(options: LegacyMigrationOptions): Promise<LegacyMigrationPlan> {
  const sources = (await Promise.all(sourceDefinitions(options).map(readStableSource)))
    .filter((source): source is LegacySourceSnapshot => source !== undefined);
  const projects = await projectSeeds(sources.find((source) => source.kind === "projects"));
  const adoptions = await adoptionSeeds(new SessionReader(options.sessionsDirectory), projects);
  const userDefaults = options.userDefaults ? validateUserDefaults(options.userDefaults) : undefined;
  const userDefaultsBytes = userDefaults ? Buffer.from(JSON.stringify(userDefaults)) : undefined;
  const sourceManifest: LegacySourceManifestEntry[] = [
    ...sources.map(({ document: _document, sourceBytes: _sourceBytes, ...entry }) => entry),
    ...adoptions.manifest,
    ...(userDefaultsBytes ? [{
      kind: "userDefaults" as const,
      path: "dcode-user-defaults://startup-snapshot",
      size: userDefaultsBytes.byteLength,
      modifiedAt: new Date(0).toISOString(),
      digest: digest(userDefaultsBytes),
      containsCredentialMaterial: false,
    }] : []),
  ];
  const sourceDigest = aggregateDigest(sourceManifest);
  return {
    id: deterministicId("migration", sourceDigest),
    sourceDigest,
    sourceManifest,
    sources,
    projects,
    adoptedSessions: adoptions.seeds,
    ...(userDefaults ? { userDefaults } : {}),
  };
}

export async function verifyLegacyMigrationSources(plan: LegacyMigrationPlan): Promise<void> {
  for (const source of plan.sourceManifest) {
    if (source.kind === "userDefaults") continue;
    const bytes = await readFile(source.path);
    if (bytes.byteLength !== source.size || digest(bytes) !== source.digest) {
      throw new LegacyMigrationError(
        "LEGACY_SOURCE_CHANGED",
        "Legacy source changed after migration planning",
        { kind: source.kind, path: source.path },
      );
    }
  }
}
