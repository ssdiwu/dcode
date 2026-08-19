import { randomUUID } from "node:crypto";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

type Emit = (event: string, data?: unknown) => void;

interface PendingAuthPrompt {
  finish: (value: string) => void;
  cancel: () => void;
}

interface ActiveAuthFlow {
  id: string;
  providerId: string;
  controller: AbortController;
  pending: Map<string, PendingAuthPrompt>;
}

function cancellationError(): Error {
  const error = new Error("Provider authentication was cancelled");
  error.name = "AbortError";
  return error;
}

function bounded(value: string | undefined, maximum = 8_192): string | undefined {
  if (value === undefined) return undefined;
  return value.slice(0, maximum);
}

function safeURL(value: string): string | undefined {
  if (value.length > 8_192) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function promptPayload(prompt: AuthPrompt): Record<string, unknown> {
  switch (prompt.type) {
    case "select":
      return {
        type: prompt.type,
        message: bounded(prompt.message),
        options: prompt.options.slice(0, 128).map((option) => ({
          id: bounded(option.id, 512),
          label: bounded(option.label, 2_048),
          ...(option.description ? { description: bounded(option.description, 4_096) } : {}),
        })),
      };
    case "text":
    case "secret":
    case "manual_code":
      return {
        type: prompt.type,
        message: bounded(prompt.message),
        ...(prompt.placeholder ? { placeholder: bounded(prompt.placeholder, 2_048) } : {}),
      };
  }
}

function eventPayload(event: AuthEvent): Record<string, unknown> {
  switch (event.type) {
    case "info":
      return {
        type: event.type,
        message: bounded(event.message),
        links: (event.links ?? []).flatMap((link) => {
          const url = safeURL(link.url);
          return url ? [{ url, ...(link.label ? { label: bounded(link.label, 2_048) } : {}) }] : [];
        }),
      };
    case "auth_url": {
      const url = safeURL(event.url);
      return {
        type: event.type,
        ...(url ? { url } : {}),
        ...(event.instructions ? { instructions: bounded(event.instructions) } : {}),
      };
    }
    case "device_code": {
      const verificationUri = safeURL(event.verificationUri);
      return {
        type: event.type,
        userCode: bounded(event.userCode, 2_048),
        ...(verificationUri ? { verificationUri } : {}),
        ...(event.intervalSeconds !== undefined ? { intervalSeconds: event.intervalSeconds } : {}),
        ...(event.expiresInSeconds !== undefined ? { expiresInSeconds: event.expiresInSeconds } : {}),
      };
    }
    case "progress":
      return { type: event.type, message: bounded(event.message) };
  }
}

export class ModelAuthBridge {
  private active?: ActiveAuthFlow;

  constructor(private readonly emit: Emit) {}

  get hasActiveFlow(): boolean { return this.active !== undefined; }

  async login(
    flowId: string,
    runtime: ModelRuntime,
    providerId: string,
    authType: AuthType,
  ): Promise<void> {
    if (this.active) throw new Error("Another provider authentication flow is already active");
    const flow: ActiveAuthFlow = {
      id: flowId,
      providerId,
      controller: new AbortController(),
      pending: new Map(),
    };
    this.active = flow;
    const interaction: AuthInteraction = {
      signal: flow.controller.signal,
      prompt: (prompt) => this.requestPrompt(flow, prompt),
      notify: (event) => {
        if (this.active !== flow || flow.controller.signal.aborted) return;
        this.emit("modelAuth.event", {
          flowId: flow.id,
          provider: flow.providerId,
          event: eventPayload(event),
        });
      },
    };

    try {
      await runtime.login(providerId, authType, interaction);
      flow.controller.signal.throwIfAborted();
      this.emit("modelAuth.completed", { flowId, provider: providerId });
    } finally {
      this.closeFlow(flow);
    }
  }

  respond(flowId: string, requestId: string, value: string | undefined, cancelled: boolean): boolean {
    const flow = this.active;
    if (!flow || flow.id !== flowId) return false;
    const pending = flow.pending.get(requestId);
    if (!pending) return false;
    if (cancelled) pending.cancel();
    else pending.finish(value ?? "");
    return true;
  }

  cancel(flowId: string): boolean {
    const flow = this.active;
    if (!flow || flow.id !== flowId) return false;
    flow.controller.abort();
    for (const pending of [...flow.pending.values()]) pending.cancel();
    return true;
  }

  close(): void {
    const flow = this.active;
    if (!flow) return;
    flow.controller.abort();
    this.closeFlow(flow);
  }

  private requestPrompt(flow: ActiveAuthFlow, prompt: AuthPrompt): Promise<string> {
    if (this.active !== flow || flow.controller.signal.aborted || prompt.signal?.aborted) {
      return Promise.reject(cancellationError());
    }
    const requestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        flow.pending.delete(requestId);
        flow.controller.signal.removeEventListener("abort", cancel);
        prompt.signal?.removeEventListener("abort", cancel);
      };
      const finish = (value: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.emit("modelAuth.promptClosed", { flowId: flow.id, requestId });
        resolve(value);
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.emit("modelAuth.promptClosed", { flowId: flow.id, requestId });
        reject(cancellationError());
      };
      flow.pending.set(requestId, { finish, cancel });
      flow.controller.signal.addEventListener("abort", cancel, { once: true });
      prompt.signal?.addEventListener("abort", cancel, { once: true });
      this.emit("modelAuth.request", {
        flowId: flow.id,
        provider: flow.providerId,
        requestId,
        prompt: promptPayload(prompt),
      });
    });
  }

  private closeFlow(flow: ActiveAuthFlow): void {
    if (this.active !== flow) return;
    for (const pending of [...flow.pending.values()]) pending.cancel();
    this.active = undefined;
  }
}
