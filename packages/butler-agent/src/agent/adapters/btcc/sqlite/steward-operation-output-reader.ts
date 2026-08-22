import type { Database } from "bun:sqlite";
import type { StewardObserverOperationOutputChunk } from
  "../../../../gateways/app/domain/sessions/steward-observer.ts";
import { normalizeOperationOutputChunkPayload } from
  "../../../events/operation-output-event.ts";

export function readStewardOperationOutputChunks(
  db: Database,
  input: { turnId: string; requestId: string; resultId: string },
): StewardObserverOperationOutputChunk[] {
  const rows = db.query<{ event_json: string }, [string]>(`
    SELECT progress.event_json
    FROM btcc_progress_events AS progress
    JOIN btcc_turns AS turn
      ON turn.turn_id = progress.turn_id
     AND turn.session_id = progress.session_id
    JOIN btcc_session_relations AS relation
      ON relation.child_session_id = turn.session_id
    WHERE progress.turn_id = ?
      AND progress.session_id = relation.child_session_id
    ORDER BY progress.turn_sequence ASC, progress.event_id ASC
  `).all(input.turnId);
  const chunks: StewardObserverOperationOutputChunk[] = [];
  for (const row of rows) {
    const event = parseOutputEvent(row.event_json);
    if (!event) continue;
    try {
      const payload = normalizeOperationOutputChunkPayload(event.payload);
      if (payload.requestId !== input.requestId || payload.resultId !== input.resultId) continue;
      chunks.push({
        request_id: payload.requestId,
        result_id: payload.resultId,
        result_sha256: payload.resultSha256,
        chunk_index: payload.chunkIndex,
        chunk_count: payload.chunkCount,
        byte_start: payload.byteStart,
        byte_end: payload.byteEnd,
        byte_length: payload.byteLength,
        content_base64: payload.contentBase64,
        content_sha256: payload.contentSha256,
      });
    } catch {
      // Invalid or private output is not an observer result.
    }
  }
  return chunks;
}

function parseOutputEvent(value: string): {
  payload: Record<string, unknown>;
} | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || parsed.kind !== "operation.output.chunk" ||
      parsed.visibility !== "public" || !isRecord(parsed.payload)) return null;
    return { payload: parsed.payload };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
