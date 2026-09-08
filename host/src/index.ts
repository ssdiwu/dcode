#!/usr/bin/env node
import { resolve } from "node:path";
import { inheritedApiKeyChannel } from "./api-key-channel.js";
import { JsonlDecoder, JsonlWriter } from "./jsonl.js";
import { PiHost } from "./pi-host.js";
import type { LegacyStoreKind } from "./legacy-migration.js";
import {
  ProtocolValidationError,
  errorResponse,
  isHostMethod,
  parseRequest,
  protocolEvent,
  successResponse,
  validateMethodParams,
} from "./protocol.js";

interface CliOptions {
  agentDir?: string;
  sessionsDirectory?: string;
  leaseAgentDir?: string;
  searchCacheDirectory?: string;
  dataRoot?: string;
}

function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (
      argument === "--agent-dir"
      || argument === "--sessions-dir"
      || argument === "--lease-agent-dir"
      || argument === "--search-cache-dir"
      || argument === "--data-root"
    ) {
      if (!value) throw new Error(`Missing value for ${argument}`);
      const path = resolve(value);
      if (argument === "--agent-dir") options.agentDir = path;
      else if (argument === "--sessions-dir") options.sessionsDirectory = path;
      else if (argument === "--lease-agent-dir") options.leaseAgentDir = path;
      else if (argument === "--search-cache-dir") options.searchCacheDirectory = path;
      else options.dataRoot = path;
      index += 1;
      continue;
    }
    if (argument === "--help") {
      process.stderr.write("Usage: pi-dcode-host [--agent-dir PATH] [--sessions-dir PATH] [--lease-agent-dir PATH] [--search-cache-dir PATH] [--data-root PATH]\n");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function rawCorrelation(value: unknown): { id: string; method: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 128) return undefined;
  const method = typeof record.method === "string" && record.method.length > 0 && record.method.length <= 128
    ? record.method
    : "protocol";
  return { id: record.id, method };
}

function errorDetails(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof ProtocolValidationError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  }
  if (typeof error === "object" && error !== null) {
    const value = error as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof value.code === "string" && typeof value.message === "string") {
      return value.details === undefined
        ? { code: value.code, message: value.message }
        : { code: value.code, message: value.message, details: value.details };
    }
  }
  return { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
}

function legacyUserDefaultsSnapshot(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`D Code legacy UserDefaults snapshot is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("D Code legacy UserDefaults snapshot must be an object");
  }
  return value as Record<string, unknown>;
}

function legacySourcePathOverrides(environment: NodeJS.ProcessEnv): Partial<Record<LegacyStoreKind, string>> {
  const keys: Array<[string, LegacyStoreKind]> = [
    ["D_CODE_PROJECT_STORE_PATH", "projects"],
    ["D_CODE_SESSION_DRAFT_STORE_PATH", "sessionDrafts"],
    ["D_CODE_SESSION_ARCHIVE_STORE_PATH", "sessionArchives"],
    ["D_CODE_SESSION_PIN_STORE_PATH", "sessionPins"],
    ["D_CODE_SESSION_CHANGE_STORE_PATH", "sessionChanges"],
    ["D_CODE_FOLLOW_UP_QUEUE_STORE_PATH", "followUpQueues"],
    ["D_CODE_ACTIVITY_ATTENTION_STORE_PATH", "activityAttention"],
    ["D_CODE_SELF_EVOLUTION_RUN_STORE_PATH", "selfEvolution"],
  ];
  return Object.fromEntries(keys.flatMap(([environmentKey, kind]) => {
    const value = environment[environmentKey];
    return value ? [[kind, resolve(value)]] : [];
  })) as Partial<Record<LegacyStoreKind, string>>;
}

const options = parseCli(process.argv.slice(2));
const legacyUserDefaults = legacyUserDefaultsSnapshot(process.env.D_CODE_LEGACY_USER_DEFAULTS_JSON);
const legacySourcePaths = legacySourcePathOverrides(process.env);
delete process.env.D_CODE_LEGACY_USER_DEFAULTS_JSON;
const writer = new JsonlWriter(process.stdout);
const decoder = new JsonlDecoder();
const MAX_PENDING_REQUESTS = 128;
let requestQueue = Promise.resolve();
const activeRequests = new Set<Promise<void>>();
let pendingRequests = 0;
let inputEnded = false;
let exiting = false;
let parentWatch: NodeJS.Timeout | undefined;

const host = new PiHost({
  ...options,
  ...(legacyUserDefaults ? { legacyUserDefaults } : {}),
  ...(Object.keys(legacySourcePaths).length > 0 ? { legacySourcePaths } : {}),
  emit: (event, data) => {
    void writer.write(protocolEvent(event, data)).catch((error) => {
      process.stderr.write(`D Code host output error: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  },
});

let credentialInputReady=false;
const closeApiKeyChannel=inheritedApiKeyChannel((providerId,key,id)=>credentialInputReady&&!exiting?host.connectApiKey(providerId,key,id):Promise.resolve({ok:false,code:"UNAVAILABLE"}));

async function handleValue(value: unknown): Promise<void> {
  const correlation = rawCorrelation(value);
  try {
    const request = parseRequest(value);
    if (!isHostMethod(request.method)) {
      await writer.write(errorResponse(request.id, request.method, "METHOD_NOT_FOUND", `Unknown method: ${request.method}`));
      return;
    }
    validateMethodParams(request.method, request.params);
    const result = await host.handle(request.method, request.params);
    await writer.write(successResponse(request.id, request.method, result));
    if (host.wantsShutdown) await shutdown(0);
  } catch (error) {
    const failure = errorDetails(error);
    if (correlation) {
      await writer.write(errorResponse(
        correlation.id,
        correlation.method,
        failure.code,
        failure.message,
        failure.details,
      ));
    } else {
      await writer.write(protocolEvent("protocol.error", failure));
    }
  }
}

function schedule(value: unknown): void {
  pendingRequests += 1;
  if (pendingRequests >= MAX_PENDING_REQUESTS) process.stdin.pause();
  let bypassQueue = false;
  try {
    const request = parseRequest(value);
    const method = request.method;
    bypassQueue = method === "extension.respond"
      || method === "session.search"
      || typeof request.params.runtimeId === "string";
  } catch {
    // Invalid envelopes stay on the serial path and are reported by handleValue.
  }
  const operation = bypassQueue
    ? Promise.resolve().then(() => handleValue(value))
    : requestQueue.then(() => handleValue(value));
  const task = operation.catch((error) => {
    process.stderr.write(`D Code host request error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  });
  if (!bypassQueue) requestQueue = task;
  activeRequests.add(task);
  void task.finally(() => {
    activeRequests.delete(task);
    pendingRequests -= 1;
    if (!inputEnded && !exiting && pendingRequests < MAX_PENDING_REQUESTS / 2) process.stdin.resume();
  });
}

async function drainRequests(): Promise<void> {
  await requestQueue;
  await Promise.all([...activeRequests]);
}

async function shutdown(exitCode: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  credentialInputReady=false;closeApiKeyChannel();
  if (parentWatch) clearInterval(parentWatch);
  const forcedExitCode = exitCode === 0 ? 1 : exitCode;
  const forceExit = setTimeout(() => process.exit(forcedExitCode), 20_000);
  process.stdin.pause();
  try {
    await host.close();
    await writer.flush();
  } catch (error) {
    process.stderr.write(`D Code host shutdown error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    exitCode = exitCode === 0 ? 1 : exitCode;
  }
  clearTimeout(forceExit);
  process.stdin.destroy();
  process.exit(exitCode);
}

process.stdin.on("data", (chunk: Buffer) => {
  for (const result of decoder.push(chunk)) {
    if (result.ok) schedule(result.value);
    else void writer.write(protocolEvent("protocol.error", result.error));
  }
});

process.stdin.on("end", () => {
  inputEnded = true;
  for (const result of decoder.end()) {
    if (result.ok) schedule(result.value);
    else void writer.write(protocolEvent("protocol.error", result.error));
  }
  void drainRequests().then(() => shutdown(0));
});

// SIGINT 与 SIGTERM 同走 graceful shutdown（ADR 0027：中断善后不留半状态）。
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal === "SIGHUP" ? 129 : 143);
  });
}

process.on("uncaughtException", (error) => {
  process.stderr.write(`D Code host uncaught exception: ${error.stack ?? error.message}\n`);
  void shutdown(1);
});

process.on("unhandledRejection", (error) => {
  process.stderr.write(`D Code host unhandled rejection: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  void shutdown(1);
});

const launchParentPid = process.ppid;
parentWatch = setInterval(() => {
  if (!exiting && process.ppid !== launchParentPid) void shutdown(143);
}, 1_000);
parentWatch.unref();

process.stdin.pause();
try {
  await host.start();
} catch (error) {
  const failure = errorDetails(error);
  await writer.write(protocolEvent("host.startFailed", failure));
  await writer.flush();
  process.stderr.write(`D Code host startup error: ${failure.message}\n`);
  process.exit(1);
}
credentialInputReady=true;
await writer.write(protocolEvent("host.ready", {
  protocolVersion: 1,
  pid: process.pid,
  agentDir: host.agentDir,
  sessionsDirectory: host.sessionsDirectory,
  dataRoot: host.productDataRoot,
}));
process.stdin.resume();
