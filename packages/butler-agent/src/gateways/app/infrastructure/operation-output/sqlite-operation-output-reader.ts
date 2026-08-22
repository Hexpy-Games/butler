import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { digest } from
  "../../../../agent/btcc/identity/index.ts";
import type { OperationOutputView } from
  "../../interface/protocol/app-protocol.ts";
import type { StewardObserverReader } from
  "../../domain/sessions/steward-observer.ts";

const OUTPUT_PAGE_BYTES = 64 * 1024;

type GuidedToolResult = {
  request_id: string;
  result_id: string;
  result_sha256: string;
  chunk_index: number;
  chunk_count: number;
  byte_start: number;
  byte_end: number;
  byte_length: number;
  content_base64: string;
  content_sha256: string;
};

export class SqliteOperationOutputReader {
  constructor(
    private readonly db: Database,
    private readonly stewardObserver: StewardObserverReader,
  ) {}

  read(input: {
    turnId: string;
    requestId: string;
    resultId: string;
    byteStart: number;
    allowAliasedRequest?: boolean;
  }): OperationOutputView | null {
    const stored = this.readChunks(input.turnId, input.requestId, input.resultId);
    const aliased = stored.length === 0 && input.allowAliasedRequest === true
      ? this.readAliasedChunks(input.turnId, input.resultId)
      : [];
    const child = stored.length === 0 && aliased.length === 0
      ? this.stewardObserver.readOperationOutputChunks(input)
      : [];
    const chunks = stored.length > 0 ? stored : aliased.length > 0 ? aliased : child;
    const payload = completeOutput(chunks, input.resultId);
    if (!payload) return null;
    const byteStart = Math.max(0, Math.min(input.byteStart, payload.byteLength));
    const bytes = payload.subarray(
      byteStart,
      Math.min(payload.byteLength, byteStart + OUTPUT_PAGE_BYTES),
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
      byte_length: payload.byteLength,
      complete: byteEnd >= payload.byteLength,
    };
  }

  private readChunks(turnId: string, requestId: string, expectedResultId: string): GuidedToolResult[] {
    return this.db.query<GuidedToolResult, [string, string, string]>(`
      SELECT request_id, result_id, result_sha256, chunk_index, chunk_count,
        byte_start, byte_end, byte_length, content_base64, content_sha256
      FROM app_operation_output_chunks
      WHERE turn_id = ? AND request_id = ? AND result_id = ?
      ORDER BY chunk_index
    `).all(turnId, requestId, expectedResultId);
  }

  private readAliasedChunks(turnId: string, expectedResultId: string): GuidedToolResult[] {
    return this.db.query<GuidedToolResult, [string, string, string, string]>(`
      SELECT request_id, result_id, result_sha256, chunk_index, chunk_count,
        byte_start, byte_end, byte_length, content_base64, content_sha256
      FROM app_operation_output_chunks
      WHERE turn_id = ? AND result_id = ?
        AND request_id = (
          SELECT request_id FROM app_operation_output_chunks
          WHERE turn_id = ? AND result_id = ?
          ORDER BY created_at, request_id
          LIMIT 1
        )
      ORDER BY request_id, chunk_index
    `).all(turnId, expectedResultId, turnId, expectedResultId);
  }
}

function completeOutput(rows: GuidedToolResult[], expectedResultId: string): Buffer | null {
  if (rows.length === 0) return null;
  const first = rows[0]!;
  if (rows.length !== first.chunk_count || first.result_id !== expectedResultId) return null;
  let expectedStart = 0;
  const chunks: Buffer[] = [];
  for (const [index, row] of rows.entries()) {
    if (
      row.request_id !== first.request_id || row.result_id !== first.result_id ||
      row.result_sha256 !== first.result_sha256 || row.chunk_index !== index ||
      row.chunk_count !== first.chunk_count || row.byte_length !== first.byte_length ||
      row.byte_start !== expectedStart || row.byte_end < row.byte_start
    ) return null;
    const chunk = Buffer.from(row.content_base64, "base64");
    if (
      chunk.byteLength !== row.byte_end - row.byte_start ||
      sha256(chunk) !== row.content_sha256
    ) return null;
    chunks.push(chunk);
    expectedStart = row.byte_end;
  }
  const payload = Buffer.concat(chunks);
  if (
    expectedStart !== first.byte_length || payload.byteLength !== first.byte_length ||
    sha256(payload) !== first.result_sha256 ||
    digest(`btcc-guided-tool-result.v1\0${first.result_sha256}`) !== expectedResultId
  ) return null;
  return payload;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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
