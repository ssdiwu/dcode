import type { HostEvent, HostResponse } from "./envelope.js";
import { ProtocolClientError } from "./envelope.js";
import { JsonlDecoder } from "./jsonl.js";

export interface ProtocolClientOptions {
  /** 传输层唯一出口：把一行已编码的协议消息写出去（不含换行符）。 */
  sendLine: (line: string) => void;
  requestTimeoutMs?: number;
  onParseError?: (error: { code: string; message: string }) => void;
  onMalformedMessage?: (value: unknown) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 传输无关的 Protocol v1 客户端（电话线预铺约束之一）：
 * 只认「进来的字节」和「出去的行」，不关心底下是 stdio 管道还是
 * 将来的本地 WebSocket。换传输时本文件零改动。
 */
export class ProtocolClient {
  private readonly decoder = new JsonlDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventHandlers = new Set<(event: HostEvent) => void>();
  private nextSerial = 0;
  private disposed = false;

  constructor(private readonly options: ProtocolClientOptions) {}

  /** 传输层收到任意分片时调用。 */
  feed(chunk: Uint8Array): void {
    for (const result of this.decoder.push(chunk)) {
      if (!result.ok) {
        this.options.onParseError?.(result.error);
        continue;
      }
      this.handleMessage(result.value);
    }
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new ProtocolClientError("CLIENT_DISPOSED", "Protocol client is disposed"));
    }
    const id = `c${++this.nextSerial}`;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 120_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProtocolClientError("REQUEST_TIMEOUT", `Request ${method} (${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
      this.options.sendLine(
        JSON.stringify({ version: 1, type: "request", id, method, params }),
      );
    });
  }

  onEvent(handler: (event: HostEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  dispose(): void {
    this.disposed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new ProtocolClientError("CLIENT_DISPOSED", "Protocol client is disposed"));
    }
    this.pending.clear();
    this.eventHandlers.clear();
  }

  private handleMessage(value: unknown): void {
    if (typeof value !== "object" || value === null) {
      this.options.onMalformedMessage?.(value);
      return;
    }
    const message = value as Record<string, unknown>;
    if (message.version !== 1) {
      this.options.onMalformedMessage?.(value);
      return;
    }
    if (message.type === "event") {
      if (typeof message.event !== "string") {
        this.options.onMalformedMessage?.(value);
        return;
      }
      const event = message as unknown as HostEvent;
      for (const handler of [...this.eventHandlers]) handler(event);
      return;
    }
    if (message.type === "response") {
      if (typeof message.id !== "string") {
        this.options.onMalformedMessage?.(value);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const response = message as unknown as HostResponse;
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        const error = response.error;
        pending.reject(
          new ProtocolClientError(
            error.code,
            error.message,
            error.details,
          ),
        );
      }
    }
  }
}
