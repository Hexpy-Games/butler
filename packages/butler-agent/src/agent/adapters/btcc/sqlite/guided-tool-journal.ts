import type { Database } from "bun:sqlite";
import { digest, stableJson } from "./identity.ts";

export type GuidedToolJournalRecord = {
  callId: string;
  toolName: string;
  rawArguments: string;
  arguments: Record<string, unknown>;
  status: "started" | "completed" | "failed" | "cancelled";
  result?: unknown;
  resultSha256?: string;
  errorCode?: string;
};

type GuidedToolCallRow = {
  call_id: string;
  tool_name: string;
  raw_arguments: string;
  arguments_json: string;
  turn_sequence: number | null;
  status: GuidedToolJournalRecord["status"];
  result_json: string | null;
  result_sha256: string | null;
  error_code: string | null;
};

export class SqliteGuidedToolJournal {
  constructor(private readonly db: Database) {}

  start(input: {
    turnId: string;
    callId: string;
    toolName: string;
    rawArguments: string;
    arguments: Record<string, unknown>;
  }): void {
    const argumentsJson = stableJson(input.arguments);
    const startedAt = new Date().toISOString();
    this.db.query(`
      INSERT OR IGNORE INTO btcc_guided_tool_calls (
        call_id, turn_id, tool_name, raw_arguments, arguments_json,
        turn_sequence, status, started_at
      )
      SELECT ?, ?, ?, ?, ?, COALESCE(MAX(turn_sequence), 0) + 1, 'started', ?
      FROM btcc_guided_tool_calls WHERE turn_id = ?
    `).run(
      input.callId,
      input.turnId,
      input.toolName,
      input.rawArguments,
      argumentsJson,
      startedAt,
      input.turnId,
    );
    const current = this.db.query<{
      turn_id: string;
      tool_name: string;
      raw_arguments: string;
      arguments_json: string;
    }, [string]>(`
      SELECT turn_id, tool_name, raw_arguments, arguments_json
      FROM btcc_guided_tool_calls WHERE call_id = ?
    `).get(input.callId);
    const currentArgumentsJson = current
      ? stableJson(JSON.parse(current.arguments_json) as unknown)
      : null;
    if (!current || current.turn_id !== input.turnId || current.tool_name !== input.toolName ||
      currentArgumentsJson !== argumentsJson) {
      throw new Error("Guided tool call identity conflict");
    }
  }

  finish(input: {
    callId: string;
    status: "completed" | "failed" | "cancelled";
    result?: unknown;
    errorCode?: string;
  }): void {
    const resultJson = input.result === undefined ? null : json(input.result);
    const resultSha256 = resultJson === null ? null : digest(resultJson);
    const updated = this.db.query(`
      UPDATE btcc_guided_tool_calls SET status = ?, result_json = ?,
        result_sha256 = ?, error_code = ?, finished_at = ?
      WHERE call_id = ? AND status = 'started'
    `).run(
      input.status,
      resultJson,
      resultSha256,
      input.errorCode ?? null,
      new Date().toISOString(),
      input.callId,
    );
    if (updated.changes === 1) return;
    const current = this.db.query<{
      status: string;
      result_json: string | null;
      error_code: string | null;
    }, [string]>(`
      SELECT status, result_json, error_code FROM btcc_guided_tool_calls
      WHERE call_id = ?
    `).get(input.callId);
    if (!current || current.status !== input.status || current.result_json !== resultJson ||
      current.error_code !== (input.errorCode ?? null)) {
      throw new Error("Guided tool result identity conflict");
    }
  }

  find(callId: string): GuidedToolJournalRecord | null {
    const row = this.db.query<GuidedToolCallRow, [string]>(`
      SELECT call_id, tool_name, raw_arguments, arguments_json, turn_sequence, status,
        result_json, result_sha256, error_code
      FROM btcc_guided_tool_calls WHERE call_id = ?
    `).get(callId);
    return row ? hydrate(row) : null;
  }

  list(turnId: string): GuidedToolJournalRecord[] {
    return this.db.query<GuidedToolCallRow, [string]>(`
      SELECT call_id, tool_name, raw_arguments, arguments_json, turn_sequence, status,
        result_json, result_sha256, error_code
      FROM btcc_guided_tool_calls
      WHERE turn_id = ? ORDER BY turn_sequence, rowid
    `).all(turnId).map(hydrate);
  }
}

function hydrate(row: GuidedToolCallRow): GuidedToolJournalRecord {
  return {
    callId: row.call_id,
    toolName: row.tool_name,
    rawArguments: row.raw_arguments,
    arguments: JSON.parse(row.arguments_json) as Record<string, unknown>,
    status: row.status,
    ...(row.result_json !== null ? { result: JSON.parse(row.result_json) as unknown } : {}),
    ...(row.result_sha256 ? { resultSha256: row.result_sha256 } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  };
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Guided tool journal requires JSON values");
  return encoded;
}
