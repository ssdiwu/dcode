#!/usr/bin/env node
import { resolve } from "node:path";
import { JsonlDecoder, JsonlWriter } from "./jsonl.js";
import { PiHost } from "./pi-host.js";
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
    ) {
      if (!value) throw new Error(`Missing value for ${argument}`);
      const path = resolve(value);
      if (argument === "--agent-dir") options.agentDir = path;
      else if (argument === "--sessions-dir") options.sessionsDirectory = path;
      else if (argument === "--lease-agent-dir") options.leaseAgentDir = path;
      else options.searchCacheDirectory = path;
      index += 1;
      continue;
    }
    if (argument === "--help") {
      process.stderr.write("Usage: pi-dcode-host [--agent-dir PATH] [--sessions-dir PATH] [--lease-agent-dir PATH] [--search-cache-dir PATH]\n");
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

const options = parseCli(process.argv.slice(2));
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
  emit: (event, data) => {
    void writer.write(protocolEvent(event, data)).catch((error) => {
      process.stderr.write(`D Code host output error: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  },
});

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
    const method = parseRequest(value).method;
    bypassQueue = method === "extension.respond"
      || method === "modelAuth.respond"
      || method === "modelAuth.cancel"
      || method === "session.search";
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

for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => { void shutdown(signal === "SIGHUP" ? 129 : 143); });
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

process.stdin.resume();
await writer.write(protocolEvent("host.ready", {
  protocolVersion: 1,
  pid: process.pid,
  agentDir: host.agentDir,
  sessionsDirectory: host.sessionsDirectory,
}));
