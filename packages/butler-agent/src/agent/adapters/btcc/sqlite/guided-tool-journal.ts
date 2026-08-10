import type { Database } from "bun:sqlite";
import { digest, stableJson } from "./identity.ts";
import {
  GuidedWorkToolResultReader,
  type GuidedExactResultSelector,
  type GuidedExactOperationResult,
  type GuidedResultReadScope,
  type GuidedResultBatchFact,
} from "./guided-work-tool-result-reader.ts";
import { guidedWorkResultRef } from "./guided-work-tool-result-writer.ts";
import {
  READ_OPERATION_RESULTS_TOOL_NAME,
  REPLACE_PHASE_CONTINUITY_TOOL_NAME,
  type PhaseContinuity,
} from "../../../tools/m1-compact-replay.ts";
import {
  captureGuidedOperationResultStructuralFacts,
  decodeGuidedOperationResultStructuralFacts,
  encodeGuidedOperationResultStructuralFacts,
  legacyGuidedOperationResultStructuralFacts,
  type GuidedOperationResultStructuralFacts,
} from "../../../btcc/operation-results/index.ts";

export type GuidedToolJournalRecord = {
  callId: string;
  resultRef?: string;
  operationBatchId?: string;
  operationBatchOrdinal?: number;
  toolName: string;
  rawArguments: string;
  arguments: Record<string, unknown>;
  status: "started" | "completed" | "failed" | "cancelled";
  result?: unknown;
  resultSha256?: string;
  structuralFacts?: GuidedOperationResultStructuralFacts;
  errorCode?: string;
};

type GuidedToolCallRow = {
  call_id: string;
  result_ref: string | null;
  operation_batch_id: string | null;
  operation_batch_ordinal: number | null;
  tool_name: string;
  raw_arguments: string;
  arguments_json: string;
  status: GuidedToolJournalRecord["status"];
  result_json: string | null;
  result_sha256: string | null;
  structural_facts_json: string | null;
  error_code: string | null;
};

type PhaseContinuityRow = {
  result_json: string;
  result_sha256: string | null;
};

export class SqliteGuidedToolJournal {
  private readonly resultReader: GuidedWorkToolResultReader;

  constructor(private readonly db: Database) {
    this.resultReader = new GuidedWorkToolResultReader(db);
  }

  start(input: {
    turnId: string;
    callId: string;
    toolName: string;
    rawArguments: string;
    arguments: Record<string, unknown>;
    operationBatchId?: string;
    operationBatchOrdinal?: number;
  }): void {
    const argumentsJson = stableJson(input.arguments);
    const resultRef = guidedWorkResultRef(input.callId);
    this.db.query(`
      INSERT OR IGNORE INTO btcc_guided_tool_calls (
        call_id, result_ref, turn_id, tool_name, raw_arguments, arguments_json,
        operation_batch_id, operation_batch_ordinal, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'started', ?)
    `).run(
      input.callId,
      resultRef,
      input.turnId,
      input.toolName,
      input.rawArguments,
      argumentsJson,
      input.operationBatchId ?? null,
      input.operationBatchOrdinal ?? null,
      new Date().toISOString(),
    );
    const current = this.db.query<{
      result_ref: string | null;
      turn_id: string;
      tool_name: string;
      raw_arguments: string;
      arguments_json: string;
      operation_batch_id: string | null;
      operation_batch_ordinal: number | null;
    }, [string]>(`
      SELECT result_ref, turn_id, tool_name, raw_arguments, arguments_json,
        operation_batch_id, operation_batch_ordinal
      FROM btcc_guided_tool_calls WHERE call_id = ?
    `).get(input.callId);
    const currentArgumentsJson = current
      ? stableJson(JSON.parse(current.arguments_json) as unknown)
      : null;
    if (!current || current.result_ref !== resultRef ||
      current.turn_id !== input.turnId || current.tool_name !== input.toolName ||
      currentArgumentsJson !== argumentsJson ||
      current.operation_batch_id !== (input.operationBatchId ?? null) ||
      current.operation_batch_ordinal !== (input.operationBatchOrdinal ?? null)) {
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
    const toolName = this.db.query<{ tool_name: string }, [string]>(`
      SELECT tool_name FROM btcc_guided_tool_calls WHERE call_id = ?
    `).get(input.callId)?.tool_name;
    if (!toolName) throw new Error("Guided tool result identity conflict");
    const structuralFactsJson = encodeGuidedOperationResultStructuralFacts(
      captureGuidedOperationResultStructuralFacts({
        toolName,
        status: input.status,
        ...(input.result === undefined ? {} : { result: input.result }),
      }),
    );
    const updated = this.db.query(`
      UPDATE btcc_guided_tool_calls SET status = ?, result_json = ?,
        result_sha256 = ?, structural_facts_json = ?, error_code = ?, finished_at = ?
      WHERE call_id = ? AND status = 'started'
    `).run(
      input.status,
      resultJson,
      resultSha256,
      structuralFactsJson,
      input.errorCode ?? null,
      new Date().toISOString(),
      input.callId,
    );
    if (updated.changes === 1) return;
    const current = this.db.query<{
      status: string;
      result_json: string | null;
      structural_facts_json: string | null;
      error_code: string | null;
    }, [string]>(`
      SELECT status, result_json, structural_facts_json, error_code
      FROM btcc_guided_tool_calls
      WHERE call_id = ?
    `).get(input.callId);
    if (!current || current.status !== input.status || current.result_json !== resultJson ||
      current.structural_facts_json !== structuralFactsJson ||
      current.error_code !== (input.errorCode ?? null)) {
      throw new Error("Guided tool result identity conflict");
    }
  }

  find(callId: string): GuidedToolJournalRecord | null {
    const row = this.db.query<GuidedToolCallRow, [string]>(`
      SELECT call_id, result_ref, operation_batch_id, operation_batch_ordinal,
        tool_name, raw_arguments, arguments_json, status,
        result_json, result_sha256, structural_facts_json, error_code
      FROM btcc_guided_tool_calls WHERE call_id = ?
    `).get(callId);
    return row ? hydrate(row) : null;
  }

  list(turnId: string): GuidedToolJournalRecord[] {
    return this.db.query<GuidedToolCallRow, [string]>(`
      SELECT call_id, result_ref, operation_batch_id, operation_batch_ordinal,
        tool_name, raw_arguments, arguments_json, status,
        result_json, result_sha256, structural_facts_json, error_code
      FROM btcc_guided_tool_calls WHERE turn_id = ? ORDER BY started_at, call_id
    `).all(turnId).map(hydrate);
  }

  /** Loads control summaries and source identities without source result bodies. */
  listForCompactReplay(turnId: string): GuidedToolJournalRecord[] {
    return this.db.query<GuidedToolCallRow, [string, string, string]>(`
      SELECT call_id, result_ref, operation_batch_id, operation_batch_ordinal,
        tool_name, raw_arguments, arguments_json, status,
        CASE WHEN tool_name IN (?, ?) THEN result_json ELSE NULL END AS result_json,
        result_sha256, structural_facts_json, error_code
      FROM btcc_guided_tool_calls WHERE turn_id = ? ORDER BY started_at, call_id
    `).all(
      READ_OPERATION_RESULTS_TOOL_NAME,
      REPLACE_PHASE_CONTINUITY_TOOL_NAME,
      turnId,
    ).map(hydrate);
  }

  readExactResult(input: {
    selector: GuidedExactResultSelector;
    scope: GuidedResultReadScope;
  }): GuidedExactOperationResult {
    return this.resultReader.readExact(input);
  }

  readExactResultRange(input: {
    selectors: readonly GuidedExactResultSelector[];
    scope: GuidedResultReadScope;
  }): GuidedExactOperationResult[] {
    return this.resultReader.readExactRange(input);
  }

  readWorkResultBatchFacts(input: {
    selectors: readonly Extract<GuidedExactResultSelector, { kind: "work" }>[];
    scope: GuidedResultReadScope;
  }): GuidedResultBatchFact[] {
    return this.resultReader.readWorkBatchFacts(input);
  }

  readLatestPhaseContinuity(input: {
    turnId: string;
    workId: string | null;
  }): PhaseContinuity | null {
    const rows = this.db.query<PhaseContinuityRow, [string, string]>(`
      SELECT call.result_json, call.result_sha256
      FROM btcc_guided_tool_calls call
      WHERE call.turn_id = ? AND call.tool_name = ?
        AND call.status = 'completed' AND call.result_json IS NOT NULL
      ORDER BY call.finished_at DESC, call.call_id DESC
    `).all(input.turnId, REPLACE_PHASE_CONTINUITY_TOOL_NAME);
    for (const row of rows) {
      if (!row.result_sha256 || digest(row.result_json) !== row.result_sha256) {
        throw new Error("guided_phase_continuity_hash_mismatch");
      }
      const parsed = JSON.parse(row.result_json) as Record<string, unknown>;
      if ((parsed.work_id ?? null) !== input.workId) continue;
      const continuity = parsed.phase_continuity;
      if (isPhaseContinuity(continuity)) return continuity;
    }
    return null;
  }
}

function isPhaseContinuity(value: unknown): value is PhaseContinuity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.objectiveState === "string" &&
    stringArray(record.integratedDecisions) &&
    stringArray(record.unresolvedQuestions) &&
    typeof record.nextBatchPurpose === "string" &&
    typeof record.publicActivity === "string";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hydrate(row: GuidedToolCallRow): GuidedToolJournalRecord {
  return {
    callId: row.call_id,
    resultRef: row.result_ref ?? guidedWorkResultRef(row.call_id),
    ...(row.operation_batch_id
      ? { operationBatchId: row.operation_batch_id }
      : {}),
    ...(row.operation_batch_ordinal !== null
      ? { operationBatchOrdinal: row.operation_batch_ordinal }
      : {}),
    toolName: row.tool_name,
    rawArguments: row.raw_arguments,
    arguments: JSON.parse(row.arguments_json) as Record<string, unknown>,
    status: row.status,
    ...(row.result_json !== null ? { result: JSON.parse(row.result_json) as unknown } : {}),
    ...(row.result_sha256 ? { resultSha256: row.result_sha256 } : {}),
    ...(row.status === "started"
      ? {}
      : {
          structuralFacts: row.structural_facts_json
            ? decodeGuidedOperationResultStructuralFacts(row.structural_facts_json)
            : legacyGuidedOperationResultStructuralFacts({
                status: row.status,
                resultSha256: row.result_sha256,
              }),
        }),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  };
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Guided tool journal requires JSON values");
  return encoded;
}
