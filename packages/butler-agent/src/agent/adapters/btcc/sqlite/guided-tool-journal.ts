import type { Database } from "bun:sqlite";
import { digest, stableJson } from "./identity.ts";
import type {
  GuidedToolJournal,
  GuidedToolJournalRecord,
  OperationResultDeliveryState,
} from "../../../btcc/index.ts";

type GuidedToolCallRow = {
  journal_ordinal?: number;
  call_id: string;
  tool_name: string;
  raw_arguments: string;
  arguments_json: string;
  turn_sequence: number | null;
  status: GuidedToolJournalRecord["status"];
  result_json: string | null;
  result_sha256: string | null;
  error_code: string | null;
  delivery_state: OperationResultDeliveryState | null;
  delivery_round_id: string | null;
  delivery_response_sha256: string | null;
};

export class SqliteGuidedToolJournal implements GuidedToolJournal {
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
      SELECT call_id, tool_name, raw_arguments, arguments_json, status,
        result_json, result_sha256, error_code, delivery_state,
        delivery_round_id, delivery_response_sha256
      FROM btcc_guided_tool_calls WHERE call_id = ?
    `).get(callId);
    return row ? hydrate(row) : null;
  }

  findForTurn(turnId: string, callId: string): GuidedToolJournalRecord | null {
    const row = this.db.query<GuidedToolCallRow, [string, string]>(`
      SELECT call_id, tool_name, raw_arguments, arguments_json, status,
        result_json, result_sha256, error_code, delivery_state,
        delivery_round_id, delivery_response_sha256
      FROM btcc_guided_tool_calls WHERE turn_id = ? AND call_id = ?
    `).get(turnId, callId);
    return row ? hydrate(row) : null;
  }

  list(turnId: string): GuidedToolJournalRecord[] {
    return this.db.query<GuidedToolCallRow, [string]>(`
      SELECT rowid AS journal_ordinal,
        call_id, tool_name, raw_arguments, arguments_json, status,
        result_json, result_sha256, error_code, delivery_state,
        delivery_round_id, delivery_response_sha256
      FROM btcc_guided_tool_calls WHERE turn_id = ? ORDER BY rowid
    `).all(turnId).map(hydrate);
  }

  admitResultDelivery(input: { turnId: string; callId: string }): void {
    validateJournalId(input.turnId, "operation_result_turn_id_invalid");
    validateJournalId(input.callId, "operation_result_call_id_invalid");
    const updated = this.db.query(`
      UPDATE btcc_guided_tool_calls SET delivery_state = 'pending_delivery'
      WHERE turn_id = ? AND call_id = ? AND status = 'completed'
        AND result_json IS NOT NULL AND result_sha256 IS NOT NULL
        AND delivery_state IS NULL
    `).run(input.turnId, input.callId);
    if (updated.changes === 1) return;
    const current = this.findForTurn(input.turnId, input.callId);
    if (!current?.deliveryState) throw new Error("operation_result_delivery_admission_failed");
  }

  beginResultDelivery(input: { turnId: string; callId: string; roundId: string }): void {
    validateJournalId(input.turnId, "operation_result_turn_id_invalid");
    validateJournalId(input.callId, "operation_result_call_id_invalid");
    validateJournalId(input.roundId, "operation_result_round_id_invalid");
    const updated = this.db.query(`
      UPDATE btcc_guided_tool_calls
      SET delivery_state = 'in_flight', delivery_round_id = ?
      WHERE turn_id = ? AND call_id = ? AND delivery_state = 'pending_delivery'
    `).run(input.roundId, input.turnId, input.callId);
    if (updated.changes === 1) return;
    const current = this.findForTurn(input.turnId, input.callId);
    if (current?.deliveryState !== "in_flight" || current.deliveryRoundId !== input.roundId) {
      throw new Error("operation_result_delivery_begin_conflict");
    }
  }

  releaseResultDeliveries(input: { turnId: string; roundId: string }): void {
    validateJournalId(input.turnId, "operation_result_turn_id_invalid");
    validateJournalId(input.roundId, "operation_result_round_id_invalid");
    const rows = this.deliveryRows(input);
    if (rows.length === 0 && this.hasInFlightDelivery(input.turnId)) {
      throw new Error("operation_result_delivery_release_conflict");
    }
    if (rows.some((row) => row.delivery_state !== "in_flight")) {
      throw new Error("operation_result_delivery_release_conflict");
    }
    const updated = this.db.query(`
      UPDATE btcc_guided_tool_calls
      SET delivery_state = 'pending_delivery', delivery_round_id = NULL
      WHERE turn_id = ? AND delivery_state = 'in_flight' AND delivery_round_id = ?
    `).run(input.turnId, input.roundId);
    if (updated.changes !== rows.length) {
      throw new Error("operation_result_delivery_release_conflict");
    }
  }

  acknowledgeResultDeliveries(input: {
    turnId: string;
    roundId: string;
    responseSha256: string;
  }): void {
    validateJournalId(input.turnId, "operation_result_turn_id_invalid");
    validateJournalId(input.roundId, "operation_result_round_id_invalid");
    validateDigest(input.responseSha256, "operation_result_response_hash_invalid");
    const rows = this.deliveryRows(input);
    if (rows.length === 0 && this.hasInFlightDelivery(input.turnId)) {
      throw new Error("operation_result_delivery_acknowledgement_conflict");
    }
    if (rows.length > 0 && rows.every((row) =>
      row.delivery_state === "acknowledged" &&
      row.delivery_response_sha256 === input.responseSha256,
    )) return;
    if (rows.some((row) => row.delivery_state !== "in_flight")) {
      throw new Error("operation_result_delivery_acknowledgement_conflict");
    }
    const updated = this.db.query(`
      UPDATE btcc_guided_tool_calls
      SET delivery_state = 'acknowledged', delivery_response_sha256 = ?
      WHERE turn_id = ? AND delivery_state = 'in_flight' AND delivery_round_id = ?
    `).run(input.responseSha256, input.turnId, input.roundId);
    if (updated.changes !== rows.length) {
      throw new Error("operation_result_delivery_acknowledgement_conflict");
    }
  }

  private deliveryRows(input: { turnId: string; roundId: string }): Array<{
    delivery_state: OperationResultDeliveryState;
    delivery_response_sha256: string | null;
  }> {
    return this.db.query<{
      delivery_state: OperationResultDeliveryState;
      delivery_response_sha256: string | null;
    }, [string, string]>(`
      SELECT delivery_state, delivery_response_sha256
      FROM btcc_guided_tool_calls
      WHERE turn_id = ? AND delivery_round_id = ?
    `).all(input.turnId, input.roundId);
  }

  private hasInFlightDelivery(turnId: string): boolean {
    return Boolean(this.db.query<{ present: number }, [string]>(`
      SELECT 1 AS present FROM btcc_guided_tool_calls
      WHERE turn_id = ? AND delivery_state = 'in_flight' LIMIT 1
    `).get(turnId));
  }

  promoteAcknowledgedResult(input: { turnId: string; callId: string }): void {
    const updated = this.db.query(`
      UPDATE btcc_guided_tool_calls SET delivery_state = 'reference_only'
      WHERE turn_id = ? AND call_id = ? AND delivery_state = 'acknowledged'
    `).run(input.turnId, input.callId);
    if (updated.changes === 1) return;
    const current = this.findForTurn(input.turnId, input.callId);
    if (current?.deliveryState !== "reference_only") {
      throw new Error("operation_result_delivery_promotion_conflict");
    }
  }

}

function hydrate(row: GuidedToolCallRow): GuidedToolJournalRecord {
  if (row.result_json !== null &&
    (!row.result_sha256 || digest(row.result_json) !== row.result_sha256)) {
    throw new Error("operation_result_body_hash_mismatch");
  }
  return {
    callId: row.call_id,
    ...(validJournalOrdinal(row.journal_ordinal)
      ? { journalOrdinal: row.journal_ordinal }
      : {}),
    toolName: row.tool_name,
    rawArguments: row.raw_arguments,
    arguments: JSON.parse(row.arguments_json) as Record<string, unknown>,
    status: row.status,
    ...(row.result_json !== null ? { result: JSON.parse(row.result_json) as unknown } : {}),
    ...(row.result_sha256 ? { resultSha256: row.result_sha256 } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.delivery_state ? { deliveryState: row.delivery_state } : {}),
    ...(row.delivery_round_id ? { deliveryRoundId: row.delivery_round_id } : {}),
    ...(row.delivery_response_sha256
      ? { deliveryResponseSha256: row.delivery_response_sha256 }
      : {}),
  };
}

function validJournalOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Guided tool journal requires JSON values");
  return encoded;
}

function validateJournalId(value: string, code: string): void {
  if (!value.trim() || Buffer.byteLength(value, "utf8") > 256) throw new Error(code);
}

function validateDigest(value: string, code: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(code);
}
