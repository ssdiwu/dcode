import { ApiKeyChannel } from "./api-key-channel.js";
import type { Duplex } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { HostEvent } from "../protocol/envelope.js";
import { ProtocolClient } from "../protocol/client.js";
import { planHostLaunch, type HostLaunchInput } from "./launch.js";

export interface HostBridgeOptions extends HostLaunchInput {
  readyTimeoutMs?: number;
  onStderr?: (text: string) => void;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Host 桥：拥有 host 子进程与传输无关的协议客户端，等待 host.ready
 * 后可用。崩溃域分离（议题一）：host 退出不牵连本进程，经 onExit
 * 如实上抛，由界面呈现恢复入口。
 */
export class HostBridge {
  private constructor(
    private readonly child: ChildProcess,
    private readonly client: ProtocolClient,
    private readonly apiKeys: ApiKeyChannel,
  ) {
    this.child.on("exit", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.client.dispose();
      this.apiKeys.close();
      for (const handler of [...this.exitHandlers]) handler(code, signal);
    });
  }

  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private readonly exitHandlers = new Set<
    (code: number | null, signal: NodeJS.Signals | null) => void
  >();

  static async start(options: HostBridgeOptions): Promise<HostBridge> {
    const plan = planHostLaunch(options);
    const child = spawn(plan.command, plan.args, {
      env: {...plan.env,DCODE_CREDENTIAL_PIPE_FD:"3"},
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const client = new ProtocolClient({
      sendLine: (line) => child.stdin.write(`${line}\n`),
      onParseError: (error) =>
        process.stderr.write(
          `[dcode-client] host line decode error ${error.code}: ${error.message}\n`,
        ),
    });
    child.stdout.on("data", (chunk: Buffer) => client.feed(chunk));
    child.stderr.on("data", (chunk: Buffer) =>
      options.onStderr?.(chunk.toString("utf8")),
    );

    const bridge = new HostBridge(child, client, new ApiKeyChannel(child.stdio[3] as Duplex));
    try {
      await bridge.waitForReady(
        options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      );
    } catch (error) {
      bridge.kill();
      throw error;
    }
    return bridge;
  }

  get hasExited(): boolean {
    return this.exitCode !== null || this.exitSignal !== null;
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    return this.client.request<T>(method, params, options);
  }

  connectApiKey(providerId:string,key:string){return this.apiKeys.submit(providerId,key);}

  onEvent(handler: (event: HostEvent) => void): () => void {
    return this.client.onEvent(handler);
  }

  onExit(
    handler: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  /** 优雅停机：host.shutdown → 等待退出 → 超时 SIGTERM。 */
  async shutdown(gracefulTimeoutMs = 5_000): Promise<void> {
    if (this.hasExited) return;
    const exit = once(this.child, "exit")
      .then(() => true)
      .catch(() => true);
    try {
      await this.client.request(
        "host.shutdown",
        {},
        {
          timeoutMs: gracefulTimeoutMs,
        },
      );
    } catch {
      // shutdown 请求失败也要继续走退出等待；进程级收尾不依赖协议配合。
    }
    if (this.hasExited) return;
    const exited = await Promise.race([
      exit,
      delay(gracefulTimeoutMs).then(() => false),
    ]);
    if (!exited && !this.hasExited) {
      this.child.kill("SIGTERM");
      const terminated = await Promise.race([
        exit,
        delay(1_000).then(() => false),
      ]);
      if (!terminated && !this.hasExited) {
        this.child.kill("SIGKILL");
        const killed = await Promise.race([
          exit,
          delay(3_000).then(() => false),
        ]);
        if (!killed && !this.hasExited)
          throw new Error(
            "Host did not exit after SIGKILL; another Host must not be started",
          );
      }
    }
  }

  kill(): void {
    if (!this.hasExited) this.child.kill("SIGKILL");
  }

  private waitForReady(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      this.child.once("error", onError);
      const timer = setTimeout(() => {
        cleanup();
        this.kill();
        reject(
          new Error(`Host did not signal host.ready within ${timeoutMs}ms`),
        );
      }, timeoutMs);
      const offExit = this.onExit((code, signal) => {
        cleanup();
        reject(
          new Error(
            `Host exited before host.ready (code=${code}, signal=${signal})`,
          ),
        );
      });
      const offEvent = this.onEvent((event) => {
        if (event.event === "host.ready") {
          cleanup();
          resolve();
        }
      });
      const cleanup = () => {
        clearTimeout(timer);
        this.child.removeListener("error", onError);
        offExit();
        offEvent();
      };
    });
  }
}
