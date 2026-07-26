import { existsSync, closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { OperationOutputView } from "../../interface/protocol/app-protocol.ts";

const OUTPUT_PAGE_BYTES = 64 * 1024;

type StoredOperationResult = {
  request_scope: string;
  request_id: string;
  record_json: string;
};

export class SqliteOperationOutputReader {
  constructor(private readonly butlerData: string) {}

  read(input: {
    turnId: string;
    requestId: string;
    resultId: string;
    byteStart: number;
  }): OperationOutputView | null {
    const databasePath = join(
      this.butlerData,
      "runtime",
      "btcc",
      "operation-results.sqlite",
    );
    if (!existsSync(databasePath)) return null;
    const database = new Database(databasePath, { readonly: true });
    try {
      const stored = database.query<StoredOperationResult, [string]>(`
        SELECT request_scope, request_id, record_json
        FROM btcc_operation_results
        WHERE result_id = ?
      `).get(input.resultId);
      if (!stored || stored.request_id !== input.requestId) return null;
      if (!stored.request_scope.startsWith(`${input.turnId}:`)) return null;
      const record = JSON.parse(stored.record_json) as {
        resultRef?: { id?: string };
        payloadRef?: { sha256?: string };
        byteLength?: number;
      };
      if (record.resultRef?.id !== input.resultId) return null;
      const payloadSha256 = record.payloadRef?.sha256;
      const totalBytes = record.byteLength;
      if (
        !payloadSha256 ||
        !/^[a-f0-9]{64}$/u.test(payloadSha256) ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes === undefined ||
        totalBytes < 0
      ) {
        return null;
      }
      const payloadPath = join(
        this.butlerData,
        "runtime",
        "btcc",
        "result-payloads",
        payloadSha256,
      );
      if (!existsSync(payloadPath)) return null;
      const byteStart = Math.min(input.byteStart, totalBytes);
      const bytes = readRange(
        payloadPath,
        byteStart,
        Math.min(OUTPUT_PAGE_BYTES, totalBytes - byteStart),
      );
      const contentBytes = completeUtf8Prefix(bytes);
      const byteEnd = byteStart + contentBytes.byteLength;
      return {
        turn_id: input.turnId,
        request_id: input.requestId,
        result_id: input.resultId,
        content: contentBytes.toString("utf8"),
        byte_start: byteStart,
        byte_end: byteEnd,
        byte_length: totalBytes,
        complete: byteEnd >= totalBytes,
      };
    } finally {
      database.close();
    }
  }
}

function completeUtf8Prefix(bytes: Buffer): Buffer {
  if (bytes.byteLength === 0) return bytes;
  let leadIndex = bytes.byteLength - 1;
  while (leadIndex > 0 && isContinuationByte(bytes[leadIndex]!)) leadIndex -= 1;
  const expected = utf8SequenceLength(bytes[leadIndex]!);
  const available = bytes.byteLength - leadIndex;
  return expected > available ? bytes.subarray(0, leadIndex) : bytes;
}

function isContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function utf8SequenceLength(value: number): number {
  if ((value & 0x80) === 0) return 1;
  if ((value & 0xe0) === 0xc0) return 2;
  if ((value & 0xf0) === 0xe0) return 3;
  if ((value & 0xf8) === 0xf0) return 4;
  return 1;
}

function readRange(path: string, start: number, length: number): Buffer {
  const output = Buffer.alloc(length);
  const file = openSync(path, "r");
  try {
    const bytesRead = readSync(file, output, 0, length, start);
    return output.subarray(0, bytesRead);
  } finally {
    closeSync(file);
  }
}
