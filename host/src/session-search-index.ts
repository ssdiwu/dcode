import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

export type SessionSearchIndexState = "idle" | "building" | "updating" | "rebuilding" | "ready" | "failed";

export interface SessionSearchIndexStatus {
  state: SessionSearchIndexState;
  complete: boolean;
  progress?: { completed: number; total: number };
  revision?: number;
  message?: string;
}

export interface SessionSearchParams {
  query: string;
  requestToken: string;
  limit: number;
  projectSourceFolders: string[];
  filterSourceFolders?: string[];
  refresh: boolean;
  probe?: boolean;
}

export interface SessionSearchResult {
  sessionId: string;
  entryId?: string;
  entryDigest?: string;
  matchKind: "title" | "message";
  role?: "user" | "assistant";
  title: string;
  cwd: string;
  modified: string;
  snippet: string;
  matchCount: number;
}

export interface SessionSearchResponse {
  requestToken: string;
  index: SessionSearchIndexStatus;
  results: SessionSearchResult[];
}

interface WorkerResponse {
  type: "response";
  id: string;
  ok: boolean;
  result?: SessionSearchResponse;
  error?: { code: string; message: string };
}

interface WorkerEvent {
  type: "event";
  event: "session.searchIndexChanged";
  data: SessionSearchIndexStatus;
}

interface PendingRequest {
  resolve: (value: SessionSearchResponse) => void;
  reject: (error: Error & { code?: string }) => void;
}

export interface SessionSearchIndexOptions {
  sessionsDirectory: string;
  cacheDirectory?: string;
  emit: (event: string, data?: unknown) => void;
}

export class SessionSearchIndex {
  readonly cacheDirectory: string;
  private worker?: Worker;
  private workerFailure?: Error;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly options: SessionSearchIndexOptions) {
    this.cacheDirectory = options.cacheDirectory ?? join(homedir(), "Library", "Caches", "D Code", "Search");
  }

  async search(params: SessionSearchParams): Promise<SessionSearchResponse> {
    if (this.closed) throw this.closedError();
    const worker = this.requireWorker();
    const id = randomUUID();
    const promise = new Promise<SessionSearchResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    worker.postMessage({ type: "search", id, params });
    return await promise;
  }

  invalidate(): void {
    if (this.closed) return;
    this.worker?.postMessage({ type: "invalidate" });
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closed = true;
    const worker = this.worker;
    this.worker = undefined;
    const failure = this.closedError();
    for (const request of this.pending.values()) request.reject(failure);
    this.pending.clear();
    if (!worker) return;
    this.closePromise = (async () => {
      worker.postMessage({ type: "close" });
      await worker.terminate();
    })();
    await this.closePromise;
  }

  private requireWorker(): Worker {
    if (this.closed) throw this.closedError();
    if (this.worker) return this.worker;
    this.workerFailure = undefined;
    const execArgv = process.execArgv.filter((argument) => !argument.startsWith("--disable-warning="));
    execArgv.push("--disable-warning=ExperimentalWarning");
    const worker = new Worker(new URL("./session-search-worker.js", import.meta.url), {
      workerData: {
        sessionsDirectory: this.options.sessionsDirectory,
        cacheDirectory: this.cacheDirectory,
      },
      execArgv,
    });
    worker.on("message", (message: WorkerResponse | WorkerEvent) => this.receive(message));
    worker.on("error", (error) => this.failWorker(error));
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.worker = undefined;
        if (this.closed) return;
        if (code !== 0 && !this.workerFailure) this.failWorker(new Error(`Search worker exited with code ${code}`));
      }
    });
    this.worker = worker;
    return worker;
  }

  private receive(message: WorkerResponse | WorkerEvent): void {
    if (this.closed) return;
    if (message.type === "event") {
      this.options.emit(message.event, message.data);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok && message.result) {
      pending.resolve(message.result);
      return;
    }
    const error = Object.assign(
      new Error(message.error?.message ?? "Search index request failed"),
      { code: message.error?.code ?? "SEARCH_INDEX_FAILED" },
    );
    pending.reject(error);
  }

  private failWorker(error: Error): void {
    this.workerFailure = error;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate().catch(() => undefined);
    const failure = Object.assign(new Error(error.message), { code: "SEARCH_INDEX_FAILED" });
    for (const request of this.pending.values()) request.reject(failure);
    this.pending.clear();
    if (this.closed) return;
    this.options.emit("session.searchIndexChanged", {
      state: "failed",
      complete: false,
      message: error.message,
    } satisfies SessionSearchIndexStatus);
  }

  private closedError(): Error & { code: string } {
    return Object.assign(new Error("Search index closed"), { code: "SEARCH_INDEX_CLOSED" });
  }
}
