import type { Database } from "bun:sqlite";
import {
  normalizeOperationOutputChunkPayload,
  type OperationOutputChunkPayload,
} from "../../../../agent/events/operation-output-event.ts";

export class AppOperationOutputProjectionStore {
  constructor(private readonly db: Database) {}

  project(input: {
    turnId: string;
    payload: Record<string, unknown>;
  }): boolean {
    const chunk = normalizeOperationOutputChunkPayload(input.payload);
    const inserted = this.db.query(`
      INSERT OR IGNORE INTO app_operation_output_chunks (
        turn_id, request_id, result_id, result_sha256, chunk_index,
        chunk_count, byte_start, byte_end, byte_length, content_base64,
        content_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.turnId,
      chunk.requestId,
      chunk.resultId,
      chunk.resultSha256,
      chunk.chunkIndex,
      chunk.chunkCount,
      chunk.byteStart,
      chunk.byteEnd,
      chunk.byteLength,
      chunk.contentBase64,
      chunk.contentSha256,
      new Date().toISOString(),
    ).changes === 1;
    if (inserted) return true;
    const existing = this.db.query<StoredChunk, [string, string, string, number]>(`
      SELECT request_id, result_id, result_sha256, chunk_index, chunk_count,
        byte_start, byte_end, byte_length, content_base64, content_sha256
      FROM app_operation_output_chunks
      WHERE turn_id = ? AND request_id = ? AND result_id = ? AND chunk_index = ?
    `).get(input.turnId, chunk.requestId, chunk.resultId, chunk.chunkIndex);
    if (!existing || !sameChunk(existing, chunk)) {
      throw new Error("conflicting App operation output chunk replay");
    }
    return false;
  }
}

type StoredChunk = {
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

function sameChunk(row: StoredChunk, chunk: OperationOutputChunkPayload): boolean {
  return row.request_id === chunk.requestId &&
    row.result_id === chunk.resultId &&
    row.result_sha256 === chunk.resultSha256 &&
    row.chunk_index === chunk.chunkIndex &&
    row.chunk_count === chunk.chunkCount &&
    row.byte_start === chunk.byteStart &&
    row.byte_end === chunk.byteEnd &&
    row.byte_length === chunk.byteLength &&
    row.content_base64 === chunk.contentBase64 &&
    row.content_sha256 === chunk.contentSha256;
}
