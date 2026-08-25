import type { Database } from "bun:sqlite";
import type { ExactProjectWorkResultAuthority } from "../project-ledger/index.ts";
import type {
  GuidedOperationResultReader,
  GuidedToolJournalRecord,
  OperationResultDeliveryState,
} from "../../../btcc/index.ts";
import { digest } from "./identity.ts";

type ExactResultRow = {
  call_id: string;
  tool_name: string;
  raw_arguments: string;
  arguments_json: string;
  status: GuidedToolJournalRecord["status"];
  result_json: string | null;
  result_sha256: string | null;
  error_code: string | null;
  delivery_state: OperationResultDeliveryState | null;
  delivery_round_id: string | null;
  delivery_response_sha256: string | null;
};

type WorkResultMetadata = {
  call_id: string;
  tool_name: string;
  status: GuidedToolJournalRecord["status"];
  result_sha256: string | null;
  error_code: string | null;
  result_ref: string;
  sequence: number;
  work_id: string;
  origin_turn_id: string;
  session_id: string;
  scope_kind: "session" | "project";
  scope_ref: string;
  ledger_project_id: string | null;
  canonical_head_sha256: string | null;
};

export class SqliteGuidedOperationResultReader
implements GuidedOperationResultReader {
  constructor(
    private readonly db: Database,
    private readonly projectAuthority?: ExactProjectWorkResultAuthority,
  ) {}

  resolveResultReference(input: { turnId: string; callId: string }) {
    const canonical = this.projectAuthority?.resolve(input);
    if (canonical) {
      const link = this.workMetadataForRef(canonical.resultRef);
      if (!link) throw new Error("operation_result_project_projection_mismatch");
      this.verifyProjectMetadata(link, canonical.resultSha256);
      return {
        kind: "work" as const,
        resultRef: canonical.resultRef,
        revision: canonical.revision,
        workId: canonical.workId,
        sessionId: canonical.sessionId,
        scopeKind: "project" as const,
        scopeRef: canonical.scopeRef,
      };
    }
    const work = this.workMetadataForCall(input);
    if (work && isManagedProjectProjection(work)) {
      if (!this.projectAuthority)
        throw new Error("operation_result_project_authority_missing");
      throw new Error("operation_result_project_reference_mismatch");
    }
    return work
      ? {
          kind: "work" as const,
          resultRef: work.result_ref,
          revision: work.sequence,
          workId: work.work_id,
          sessionId: work.session_id,
          scopeKind: work.scope_kind,
          scopeRef: work.scope_ref,
        }
      : { kind: "direct" as const, resultRef: input.callId, revision: null };
  }

  readExactResultRange(input: {
    turnId: string;
    resultRef: string;
    resultSha256: string;
    revision: number | null;
    sessionId?: string;
    projectRef?: string;
    workId?: string;
    offset: number;
    length: number;
  }) {
    const work = this.workMetadataForRef(input.resultRef);
    if (work) {
      this.verifyWorkRequest(work, input);
      if (isManagedProjectProjection(work))
        this.verifyProjectMetadata(work, input.resultSha256);
      const payload = this.exactPayload(work.origin_turn_id, work.call_id);
      if (!payload) throw new Error("operation_result_missing_or_scope_mismatch");
      if (payload.tool_name !== work.tool_name)
        throw new Error("operation_result_project_reference_mismatch");
      return exactRange(payload, input);
    }
    if (input.projectRef) {
      if (this.projectAuthority?.resolve({
        turnId: input.turnId,
        callId: input.resultRef,
      })) throw new Error("operation_result_project_projection_mismatch");
    }
    const direct = this.exactPayload(input.turnId, input.resultRef);
    if (!direct) throw new Error("operation_result_missing_or_scope_mismatch");
    if (input.revision !== null)
      throw new Error("operation_result_revision_mismatch");
    return exactRange(direct, input);
  }

  private verifyWorkRequest(
    work: WorkResultMetadata,
    input: {
      revision: number | null;
      workId?: string;
      sessionId?: string;
      projectRef?: string;
    },
  ): void {
    if (input.revision !== work.sequence)
      throw new Error("operation_result_revision_mismatch");
    if (input.workId !== work.work_id)
      throw new Error("operation_result_work_mismatch");
    if (input.sessionId !== work.session_id)
      throw new Error("operation_result_session_mismatch");
    if (
      work.scope_kind === "session" &&
      (input.sessionId !== work.scope_ref || input.projectRef !== undefined)
    ) throw new Error("operation_result_scope_mismatch");
    if (work.scope_kind === "project" && input.projectRef !== work.scope_ref)
      throw new Error("operation_result_scope_mismatch");
  }

  private verifyProjectMetadata(
    work: WorkResultMetadata,
    resultSha256: string,
  ): void {
    if (!this.projectAuthority)
      throw new Error("operation_result_project_authority_missing");
    const canonical = this.projectAuthority.verify({
      resultRef: work.result_ref,
      revision: work.sequence,
      workId: work.work_id,
      sessionId: work.session_id,
      scopeRef: work.scope_ref,
      ledgerProjectId: work.ledger_project_id ?? "",
      toolCallId: work.call_id,
      turnId: work.origin_turn_id,
      resultSha256,
    });
    if (
      canonical.toolName !== work.tool_name ||
      work.result_sha256 !== canonical.resultSha256 ||
      work.status !== "completed" ||
      work.error_code !== null
    ) throw new Error("operation_result_project_reference_mismatch");
  }

  private workMetadataForCall(input: { turnId: string; callId: string }) {
    return this.db.query<WorkResultMetadata, [string, string]>(`
      ${selectWorkResultMetadata}
      WHERE result.origin_turn_id = ? AND result.tool_call_id = ? LIMIT 1
    `).get(input.turnId, input.callId);
  }

  private workMetadataForRef(resultRef: string) {
    return this.db.query<WorkResultMetadata, [string]>(`
      ${selectWorkResultMetadata} WHERE result.result_ref = ?
    `).get(resultRef);
  }

  private exactPayload(turnId: string, callId: string) {
    return this.db.query<ExactResultRow, [string, string]>(`
      ${selectExactCallFields} FROM btcc_guided_tool_calls call
      WHERE call.turn_id = ? AND call.call_id = ?
    `).get(turnId, callId);
  }
}

const selectWorkResultMetadata = `SELECT call.call_id, call.tool_name,
  call.status, call.result_sha256, call.error_code, result.result_ref,
  result.sequence, result.work_id, result.origin_turn_id, work.session_id,
  work.scope_kind, work.scope_ref, work.ledger_project_id,
  work.canonical_head_sha256
  FROM btcc_guided_work_results result
  JOIN btcc_guided_works work ON work.work_id = result.work_id
  JOIN btcc_guided_tool_calls call ON call.call_id = result.tool_call_id`;

const selectExactCallFields = `SELECT call.call_id, call.tool_name,
  call.raw_arguments, call.arguments_json, call.status, call.result_json,
  call.result_sha256, call.error_code, call.delivery_state,
  call.delivery_round_id, call.delivery_response_sha256`;

function isManagedProjectProjection(work: WorkResultMetadata): boolean {
  return work.scope_kind === "project" &&
    typeof work.ledger_project_id === "string" &&
    work.ledger_project_id.trim().length > 0 &&
    /^[a-f0-9]{64}$/u.test(work.canonical_head_sha256 ?? "");
}

function exactRange(
  row: ExactResultRow,
  input: { resultSha256: string; offset: number; length: number },
) {
  if (
    !row.result_json ||
    !row.result_sha256 ||
    digest(row.result_json) !== row.result_sha256
  ) throw new Error("operation_result_body_hash_mismatch");
  if (row.result_sha256 !== input.resultSha256)
    throw new Error("operation_result_integrity_mismatch");
  const bytes = Buffer.from(row.result_json, "utf8");
  if (input.offset >= bytes.length)
    throw new Error("operation_result_range_out_of_bounds");
  const end = input.offset + input.length;
  if (end > bytes.length)
    throw new Error("operation_result_range_out_of_bounds");
  return {
    encoding: "base64" as const,
    data: bytes.subarray(input.offset, end).toString("base64"),
    offset: input.offset,
    length: input.length,
    totalBytes: bytes.length,
    nextOffset: end < bytes.length ? end : null,
    resultSha256: row.result_sha256,
    complete: input.offset === 0 && end === bytes.length,
  };
}
