import type { Writable } from "node:stream";

export interface JsonlDecodeError {
  code: "BAD_JSON" | "LINE_TOO_LARGE";
  message: string;
}

export type JsonlDecodeResult =
  | { ok: true; value: unknown }
  | { ok: false; error: JsonlDecodeError };

export const DEFAULT_MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;

export class JsonlDecoder {
  private buffer = Buffer.alloc(0);
  private discardingOversizedLine = false;

  constructor(private readonly maxLineBytes = DEFAULT_MAX_JSONL_LINE_BYTES) {
    if (!Number.isInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new Error("maxLineBytes must be a positive integer");
    }
  }

  push(chunk: Uint8Array): JsonlDecodeResult[] {
    const results: JsonlDecodeResult[] = [];
    let incoming = Buffer.from(chunk);

    if (this.discardingOversizedLine) {
      const newline = incoming.indexOf(0x0a);
      if (newline === -1) return results;
      this.discardingOversizedLine = false;
      incoming = incoming.subarray(newline + 1);
    }

    if (incoming.length > 0) {
      this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);
    }

    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) break;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      results.push(...this.decodeLine(line));
    }

    if (this.buffer.length > this.maxLineBytes) {
      this.buffer = Buffer.alloc(0);
      this.discardingOversizedLine = true;
      results.push({
        ok: false,
        error: {
          code: "LINE_TOO_LARGE",
          message: `JSONL line exceeds ${this.maxLineBytes} bytes`,
        },
      });
    }

    return results;
  }

  end(): JsonlDecodeResult[] {
    if (this.discardingOversizedLine) {
      this.discardingOversizedLine = false;
      this.buffer = Buffer.alloc(0);
      return [];
    }
    if (this.buffer.length === 0) return [];
    const line = this.buffer;
    this.buffer = Buffer.alloc(0);
    return this.decodeLine(line);
  }

  private decodeLine(raw: Buffer): JsonlDecodeResult[] {
    const line = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, -1) : raw;
    if (line.length === 0) return [];
    if (line.length > this.maxLineBytes) {
      return [{
        ok: false,
        error: {
          code: "LINE_TOO_LARGE",
          message: `JSONL line exceeds ${this.maxLineBytes} bytes`,
        },
      }];
    }
    try {
      return [{ ok: true, value: JSON.parse(line.toString("utf8")) }];
    } catch (error) {
      return [{
        ok: false,
        error: {
          code: "BAD_JSON",
          message: error instanceof Error ? error.message : "Invalid JSON",
        },
      }];
    }
  }
}

export class JsonlWriter {
  private pending = Promise.resolve();
  private failed: Error | undefined;

  constructor(private readonly output: Writable) {
    output.on("error", (error) => {
      this.failed ??= error instanceof Error ? error : new Error(String(error));
    });
  }

  write(value: unknown): Promise<void> {
    const line = `${JSON.stringify(value)}\n`;
    const operation = this.pending.then(async () => {
      if (this.failed) throw this.failed;
      try {
        await this.writeLine(line);
      } catch (error) {
        this.failed = error instanceof Error ? error : new Error(String(error));
        throw this.failed;
      }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private writeLine(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        this.output.off("error", onError);
        this.output.off("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) => finish(error);
      const onClose = () => finish(new Error("JSONL output closed before the write completed"));
      this.output.once("error", onError);
      this.output.once("close", onClose);
      try {
        this.output.write(line, (error) => finish(error));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.failed) throw this.failed;
  }
}
