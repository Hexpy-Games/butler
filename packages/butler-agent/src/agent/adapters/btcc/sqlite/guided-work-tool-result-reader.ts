import type { Database } from "bun:sqlite";
import { digest } from "./identity.ts";
import {
  decodeGuidedOperationResultStructuralFacts,
  legacyGuidedOperationResultStructuralFacts,
  type GuidedOperationResultStructuralFacts,
} from "../../../btcc/operation-results/index.ts";

export type GuidedResultReadScope = {
  sessionId: string;
  projectRef?: string;
  workId?: string;
};

export type GuidedExactResultSelector =
  | {
    kind: "work";
    resultRef: string;
    workId: string;
    revision: number;
    resultSha256: string | null;
  }
  | {
    kind: "direct";
    resultRef: string;
    revision: null;
    resultSha256: string | null;
  };

export type GuidedExactOperationResult = {
  resultRef: string;
  sequence: number | null;
  revision: number | null;
  sessionId: string;
  scope: { kind: "session" | "project"; ref: string };
  toolCallId: string;
  originTurnId: string;
  toolName: string;
  status: "completed" | "failed" | "cancelled";
  request: unknown;
  result?: unknown;
  resultSha256?: string;
  structuralFacts?: GuidedOperationResultStructuralFacts;
  errorCode?: string;
  operationBatchId?: string;
  operationBatchOrdinal?: number;
};

export type GuidedResultBatchFact = {
  resultRef: string;
  toolCallId: string;
  operationBatchId?: string;
  operationBatchOrdinal?: number;
};

type ExactResultRow = {
  result_ref: string;
  work_id: string;
  sequence: number;
  session_id: string;
  scope_kind: "session" | "project";
  scope_ref: string;
  tool_call_id: string;
  origin_turn_id: string;
  tool_name: string;
  status: "completed" | "failed" | "cancelled";
  result_json: string | null;
  arguments_json: string;
  result_sha256: string | null;
  structural_facts_json: string | null;
  error_code: string | null;
  operation_batch_id: string | null;
  operation_batch_ordinal: number | null;
};

type DirectResultRow = {
  call_id: string;
  turn_id: string;
  tool_name: string;
  status: "completed" | "failed" | "cancelled";
  result_json: string | null;
  arguments_json: string;
  result_sha256: string | null;
  structural_facts_json: string | null;
  error_code: string | null;
  session_id: string | null;
  operation_batch_id: string | null;
  operation_batch_ordinal: number | null;
};

const MAX_EXACT_RESULT_RANGE = 4;

/** Reads existing result authority only; it cannot dispatch an operation. */
export class GuidedWorkToolResultReader {
  constructor(private readonly db: Database) {}

  readExact(input: {
    selector: GuidedExactResultSelector;
    scope: GuidedResultReadScope;
  }): GuidedExactOperationResult {
    const resultRef = input.selector.resultRef.trim();
    if (!resultRef) throw new Error("guided_result_ref_required");
    const workResult = this.db.query<ExactResultRow, [string]>(`
      SELECT result.result_ref, result.sequence, work.session_id,
        result.work_id, work.scope_kind, work.scope_ref, result.tool_call_id,
        result.origin_turn_id, call.tool_name, call.status, call.arguments_json,
        call.result_json, call.result_sha256, call.error_code,
        call.structural_facts_json,
        call.operation_batch_id, call.operation_batch_ordinal
      FROM btcc_guided_work_results result
      JOIN btcc_guided_works work ON work.work_id = result.work_id
      JOIN btcc_guided_tool_calls call ON call.call_id = result.tool_call_id
      WHERE result.result_ref = ?
    `).get(resultRef);
    if (workResult) {
      validateStoredResultHash(workResult.result_json, workResult.result_sha256);
      if (input.selector.kind !== "work") {
        throw new Error("guided_result_kind_mismatch");
      }
      validateWorkScope(workResult, input.scope, input.selector);
      return hydrateExactResult(workResult);
    }
    const direct = this.directResult(resultRef, input.scope.sessionId);
    if (!direct) throw new Error("guided_result_ref_not_found");
    validateStoredResultHash(direct.result_json, direct.result_sha256);
    if (input.selector.kind !== "direct") {
      throw new Error("guided_result_kind_mismatch");
    }
    validateDirectScope(direct, input.scope, input.selector);
    return hydrateDirectResult(resultRef, direct);
  }

  readExactRange(input: {
    selectors: readonly GuidedExactResultSelector[];
    scope: GuidedResultReadScope;
  }): GuidedExactOperationResult[] {
    if (input.selectors.length === 0) {
      throw new Error("guided_result_range_required");
    }
    if (input.selectors.length > MAX_EXACT_RESULT_RANGE) {
      throw new Error("guided_result_range_too_large");
    }
    return input.selectors.map((selector) => this.readExact({
      selector,
      scope: input.scope,
    }));
  }

  readWorkBatchFacts(input: {
    selectors: readonly Extract<GuidedExactResultSelector, { kind: "work" }>[];
    scope: GuidedResultReadScope;
  }): GuidedResultBatchFact[] {
    return input.selectors.map((selector) => {
      const row = this.db.query<{
        result_ref: string;
        work_id: string;
        sequence: number;
        session_id: string;
        scope_kind: "session" | "project";
        scope_ref: string;
        tool_call_id: string;
        result_sha256: string | null;
        operation_batch_id: string | null;
        operation_batch_ordinal: number | null;
      }, [string]>(`
        SELECT result.result_ref, result.work_id, result.sequence,
          work.session_id, work.scope_kind, work.scope_ref,
          result.tool_call_id, call.result_sha256,
          call.operation_batch_id, call.operation_batch_ordinal
        FROM btcc_guided_work_results result
        JOIN btcc_guided_works work ON work.work_id = result.work_id
        JOIN btcc_guided_tool_calls call ON call.call_id = result.tool_call_id
        WHERE result.result_ref = ?
      `).get(selector.resultRef);
      if (!row) throw new Error("guided_result_ref_not_found");
      validateWorkScope(row, input.scope, selector);
      return {
        resultRef: row.result_ref,
        toolCallId: row.tool_call_id,
        ...(row.operation_batch_id
          ? { operationBatchId: row.operation_batch_id }
          : {}),
        ...(row.operation_batch_ordinal !== null
          ? { operationBatchOrdinal: row.operation_batch_ordinal }
          : {}),
      };
    });
  }

  private directResult(
    resultRef: string,
    sessionId: string,
  ): DirectResultRow | null {
    return this.db.query<DirectResultRow, [string, string]>(`
      SELECT call.call_id, call.turn_id, call.tool_name, call.status,
        call.arguments_json,
        call.result_json, call.result_sha256, call.structural_facts_json,
        call.error_code, turn.session_id,
        call.operation_batch_id, call.operation_batch_ordinal
      FROM btcc_guided_tool_calls call
      JOIN btcc_turns turn ON turn.turn_id = call.turn_id
      WHERE call.result_ref = ? AND turn.session_id = ?
        AND call.status IN ('completed', 'failed', 'cancelled')
      LIMIT 1
    `).get(resultRef, sessionId) ?? null;
  }
}

function validateWorkScope(
  row: Pick<
    ExactResultRow,
    "session_id" | "work_id" | "scope_kind" | "scope_ref" | "sequence" |
      "result_sha256"
  >,
  scope: GuidedResultReadScope,
  selector: Extract<GuidedExactResultSelector, { kind: "work" }>,
): void {
  if (row.session_id !== scope.sessionId) {
    throw new Error("guided_result_session_mismatch");
  }
  if (selector.workId !== row.work_id ||
    (scope.workId !== undefined && scope.workId !== row.work_id)) {
    throw new Error("guided_result_work_mismatch");
  }
  if (row.scope_kind === "project") {
    if (scope.projectRef !== row.scope_ref) {
      throw new Error("guided_result_scope_mismatch");
    }
  } else if (scope.projectRef || row.scope_ref !== scope.sessionId) {
    throw new Error("guided_result_scope_mismatch");
  }
  validateRevisionAndHash(
    row.sequence,
    row.result_sha256,
    selector.revision,
    selector.resultSha256,
  );
}

function validateDirectScope(
  row: DirectResultRow,
  scope: GuidedResultReadScope,
  selector: Extract<GuidedExactResultSelector, { kind: "direct" }>,
): void {
  if (!row.session_id || row.session_id !== scope.sessionId) {
    throw new Error("guided_result_session_mismatch");
  }
  validateRevisionAndHash(
    null,
    row.result_sha256,
    selector.revision,
    selector.resultSha256,
  );
}

function validateRevisionAndHash(
  sequence: number | null,
  resultSha256: string | null,
  revision: number | null,
  expectedSha256: string | null,
): void {
  if (revision !== sequence) {
    throw new Error("guided_result_revision_mismatch");
  }
  if (expectedSha256 !== resultSha256) {
    throw new Error("guided_result_hash_mismatch");
  }
}

function validateStoredResultHash(
  resultJson: string | null,
  resultSha256: string | null,
): void {
  if (resultJson === null && resultSha256 === null) return;
  if (resultJson === null || resultSha256 === null ||
    digest(resultJson) !== resultSha256) {
    throw new Error("guided_result_body_hash_mismatch");
  }
}

function hydrateExactResult(row: ExactResultRow): GuidedExactOperationResult {
  return {
    resultRef: row.result_ref,
    sequence: row.sequence,
    revision: row.sequence,
    sessionId: row.session_id,
    scope: { kind: row.scope_kind, ref: row.scope_ref },
    toolCallId: row.tool_call_id,
    originTurnId: row.origin_turn_id,
    toolName: row.tool_name,
    status: row.status,
    request: JSON.parse(row.arguments_json) as unknown,
    ...(row.result_json === null
      ? {}
      : { result: JSON.parse(row.result_json) as unknown }),
    ...(row.result_sha256 ? { resultSha256: row.result_sha256 } : {}),
    structuralFacts: structuralFacts(row),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.operation_batch_id
      ? { operationBatchId: row.operation_batch_id }
      : {}),
    ...(row.operation_batch_ordinal !== null
      ? { operationBatchOrdinal: row.operation_batch_ordinal }
      : {}),
  };
}

function hydrateDirectResult(
  resultRef: string,
  row: DirectResultRow,
): GuidedExactOperationResult {
  return {
    resultRef,
    sequence: null,
    revision: null,
    sessionId: row.session_id!,
    scope: { kind: "session", ref: row.session_id! },
    toolCallId: row.call_id,
    originTurnId: row.turn_id,
    toolName: row.tool_name,
    status: row.status,
    request: JSON.parse(row.arguments_json) as unknown,
    ...(row.result_json === null
      ? {}
      : { result: JSON.parse(row.result_json) as unknown }),
    ...(row.result_sha256 ? { resultSha256: row.result_sha256 } : {}),
    structuralFacts: structuralFacts(row),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.operation_batch_id
      ? { operationBatchId: row.operation_batch_id }
      : {}),
    ...(row.operation_batch_ordinal !== null
      ? { operationBatchOrdinal: row.operation_batch_ordinal }
      : {}),
  };
}

function structuralFacts(
  row: Pick<
    ExactResultRow,
    "status" | "result_sha256" | "structural_facts_json"
  >,
): GuidedOperationResultStructuralFacts {
  return row.structural_facts_json
    ? decodeGuidedOperationResultStructuralFacts(row.structural_facts_json)
    : legacyGuidedOperationResultStructuralFacts({
        status: row.status,
        resultSha256: row.result_sha256,
      });
}
