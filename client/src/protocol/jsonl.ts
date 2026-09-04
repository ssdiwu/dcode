export interface JsonlDecodeError {
  code: "BAD_JSON" | "LINE_TOO_LARGE";
  message: string;
}

export type JsonlDecodeResult =
  | { ok: true; value: unknown }
  | { ok: false; error: JsonlDecodeError };

export const DEFAULT_MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;

/**
 * 与 host/src/jsonl.ts 同语义的行解码器：容忍任意分片，单行超过上限时
 * 丢弃该行并在下一段恢复；空行跳过。
 */
export class JsonlDecoder {
  private buffer = Buffer.alloc(0);
  private discardingOversizedLine = false;

  constructor(
    private readonly maxLineBytes: number = DEFAULT_MAX_JSONL_LINE_BYTES,
  ) {
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
      this.buffer =
        this.buffer.length === 0
          ? incoming
          : Buffer.concat([this.buffer, incoming]);
    }

    for (;;) {
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

  private decodeLine(line: Buffer): JsonlDecodeResult[] {
    const text = line.toString("utf8").trim();
    if (text.length === 0) return [];
    try {
      return [{ ok: true, value: JSON.parse(text) }];
    } catch (error) {
      return [
        {
          ok: false,
          error: {
            code: "BAD_JSON",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      ];
    }
  }
}
