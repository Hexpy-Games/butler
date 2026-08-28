import type { Database } from "bun:sqlite";
import type {
  ProjectWorkResultRuntime,
  ProjectWorkRuntimeProjection,
  ProjectWorkToolResultEvidence,
} from "../project-ledger/index.ts";
import { digest } from "./identity.ts";
import { isGuidedWorkControlToolName } from "./guided-work-tool-result-writer.ts";
import {
  assertProjectWorkProjectionOwnership,
  assertProjectWorkResultOwnership,
} from "./project-work-result-projection-ownership.ts";

type ToolResultRow = {
  turn_id: string;
  session_id: string;
  tool_name: string;
  status: "started" | "completed" | "failed" | "cancelled";
  result_json: string | null;
  result_sha256: string | null;
  source_turn_rowid: number | null;
  source_turn_sequence: number | null;
};

type ProjectionInput = Parameters<
  ProjectWorkRuntimeProjection["observeCanonicalWorks"]
>[0];

export class SqliteProjectWorkResultRuntime
implements ProjectWorkResultRuntime,
  Pick<ProjectWorkRuntimeProjection, "observeCanonicalWorks"> {
  constructor(private readonly db: Database) {}

  readCommittedResult(input: {
    turnId: string;
    sessionId: string;
    toolCallId: string;
  }): ProjectWorkToolResultEvidence {
    const row = this.db.query<ToolResultRow, [string]>(`
      SELECT call.turn_id, turn.session_id, call.tool_name, call.status,
        call.result_json, call.result_sha256,
        turn.rowid AS source_turn_rowid,
        call.turn_sequence AS source_turn_sequence
      FROM btcc_guided_tool_calls call
      JOIN btcc_turns turn ON turn.turn_id = call.turn_id
      WHERE call.call_id = ?
    `).get(input.toolCallId);
    if (!row || row.turn_id !== input.turnId || row.session_id !== input.sessionId)
      invalid("project_work_result_not_committed");
    if (row.status !== "completed" || isGuidedWorkControlToolName(row.tool_name))
      invalid("project_work_result_not_attachable");
    if (!row.result_json || !row.result_sha256 || digest(row.result_json) !== row.result_sha256)
      invalid("project_work_result_body_hash_mismatch");
    return {
      toolCallId: input.toolCallId,
      toolName: row.tool_name,
      status: "completed",
      resultSha256: row.result_sha256,
      originTurnId: row.turn_id,
      sourceTurnRowid: row.source_turn_rowid,
      sourceTurnSequence: row.source_turn_sequence,
    };
  }

  observeCanonicalResult(input: Parameters<ProjectWorkResultRuntime["observeCanonicalResult"]>[0]): void {
    const evidence = this.readCommittedResult({
      turnId: input.result.originTurnId,
      sessionId: input.work.sessionId,
      toolCallId: input.result.toolCallId,
    });
    if (
      evidence.toolName !== input.result.toolName ||
      evidence.resultSha256 !== input.result.resultSha256 ||
      input.result.status !== "completed"
    ) invalid("project_work_result_reference_mismatch");
    this.db.transaction(() => {
      const work = this.db.query<{
        session_id: string;
        scope_kind: string;
        scope_ref: string;
        ledger_project_id: string | null;
        canonical_head_sha256: string | null;
      }, [string]>(`
        SELECT session_id, scope_kind, scope_ref, ledger_project_id,
          canonical_head_sha256 FROM btcc_guided_works
        WHERE work_id = ?
      `).get(input.work.workId);
      if (
        !work || work.session_id !== input.work.sessionId ||
        work.scope_kind !== "project" ||
        work.scope_ref !== input.scope.appProjectId ||
        work.ledger_project_id !== input.scope.ledgerProjectId ||
        !/^[a-f0-9]{64}$/u.test(work.canonical_head_sha256 ?? "")
      ) invalid("project_work_runtime_ownership_conflict");
      const canonicalResults = input.work.resultRefs.map((result, index) => ({
        ...result,
        workId: input.work.workId,
        sequence: index + 1,
      }));
      const attached = canonicalResults.filter((result) =>
        result.resultRef === input.result.resultRef &&
        result.toolCallId === input.result.toolCallId &&
        result.toolName === input.result.toolName &&
        result.status === input.result.status &&
        result.resultSha256 === input.result.resultSha256 &&
        result.sequence === input.result.sequence &&
        result.originTurnId === input.result.originTurnId &&
        result.attachedAt === input.result.attachedAt);
      if (attached.length !== 1)
        invalid("project_work_result_reference_mismatch");
      assertProjectWorkResultOwnership(
        this.db,
        canonicalResults,
        new Set([input.work.workId]),
      );
      this.repairResultLink(input.work.workId, input.result, evidence);
    }).immediate();
  }

  observeCanonicalWorks(
    input: Parameters<ProjectWorkRuntimeProjection["observeCanonicalWorks"]>[0],
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(input.canonicalHeadSha256))
      invalid("project_work_runtime_head_invalid");
    this.db.transaction(() => {
      const evidence = this.prepareProjection(input);
      assertProjectWorkProjectionOwnership(this.db, input);
      for (const item of input.works) {
        const work = item.work;
        if (work.scope.kind !== "project")
          invalid("project_work_runtime_projection_mismatch");
        this.db.query(`
          INSERT INTO btcc_guided_works (
            work_id, session_id, scope_kind, scope_ref, ledger_project_id,
            canonical_head_sha256, origin_turn_id, origin_message_id,
            objective, status, current_plan_revision_id, created_at, updated_at
          ) VALUES (?, ?, 'project', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(work_id) DO UPDATE SET
            session_id=excluded.session_id,
            scope_kind=excluded.scope_kind,
            scope_ref=excluded.scope_ref,
            ledger_project_id=excluded.ledger_project_id,
            canonical_head_sha256=excluded.canonical_head_sha256,
            origin_turn_id=excluded.origin_turn_id,
            origin_message_id=excluded.origin_message_id,
            objective=excluded.objective,
            status=excluded.status,
            current_plan_revision_id=excluded.current_plan_revision_id,
            created_at=excluded.created_at,
            updated_at=excluded.updated_at
        `).run(
          work.workId,
          work.sessionId,
          work.scope.projectRef,
          input.ledgerProjectId,
          input.canonicalHeadSha256,
          work.origin.turnId,
          work.origin.messageId,
          work.objective,
          work.status,
          null,
          work.createdAt,
          work.updatedAt,
        );
        this.repairBindings(work.workId, work.sessionId, item.bindings);
        this.repairResultLinks(work, evidence);
      }
      const head = input.works.find(
        (item) => item.work.workId === input.sessionHeadWorkId,
      );
      if (!head) invalid("project_work_runtime_head_invalid");
      this.db.query(`
        INSERT INTO btcc_guided_work_session_heads (session_id, work_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          work_id=excluded.work_id, updated_at=excluded.updated_at
      `).run(
        head.work.sessionId,
        head.work.workId,
        head.work.updatedAt,
      );
    }).immediate();
    return Promise.resolve();
  }

  private repairBindings(
    workId: string,
    sessionId: string,
    bindings: Array<{
      bindingRevisionId: string;
      turnId: string;
      revision: number;
      boundAt: string;
      isCurrent: boolean;
    }>,
  ): void {
    for (const binding of bindings) {
      this.db.query(`
        INSERT INTO btcc_guided_turn_work_bindings (
          binding_revision_id, turn_id, session_id, work_id,
          revision, is_current, bound_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(binding_revision_id) DO UPDATE SET
          turn_id=excluded.turn_id,
          session_id=excluded.session_id,
          work_id=excluded.work_id,
          revision=excluded.revision,
          is_current=excluded.is_current,
          bound_at=excluded.bound_at
      `).run(
        binding.bindingRevisionId,
        binding.turnId,
        sessionId,
        workId,
        binding.revision,
        binding.isCurrent ? 1 : 0,
        binding.boundAt,
      );
    }
  }

  private repairResultLinks(
    work: Parameters<ProjectWorkResultRuntime["observeCanonicalResult"]>[0]["work"],
    evidence: Map<string, ProjectWorkToolResultEvidence>,
  ): void {
    work.resultRefs.forEach((result, index) => {
      this.repairResultLink(
        work.workId,
        { ...result, sequence: index + 1 },
        evidence.get(result.resultRef)!,
      );
    });
  }

  private repairResultLink(
    workId: string,
    result: Parameters<ProjectWorkResultRuntime["observeCanonicalResult"]>[0]["result"],
    evidence: ProjectWorkToolResultEvidence,
  ): void {
    this.db.query(`
      INSERT INTO btcc_guided_work_results (
        result_ref, work_id, sequence, tool_call_id, origin_turn_id,
        source_turn_rowid, source_turn_sequence, attached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(result_ref) DO UPDATE SET
        work_id=excluded.work_id,
        sequence=excluded.sequence,
        tool_call_id=excluded.tool_call_id,
        origin_turn_id=excluded.origin_turn_id,
        source_turn_rowid=excluded.source_turn_rowid,
        source_turn_sequence=excluded.source_turn_sequence,
        attached_at=excluded.attached_at
    `).run(
      result.resultRef,
      workId,
      result.sequence,
      result.toolCallId,
      result.originTurnId,
      evidence.sourceTurnRowid,
      evidence.sourceTurnSequence,
      result.attachedAt,
    );
  }

  private prepareProjection(input: ProjectionInput) {
    const evidence = new Map<string, ProjectWorkToolResultEvidence>();
    for (const { work } of input.works) {
      work.resultRefs.forEach((result) => {
        const committed = this.readCommittedResult({
          turnId: result.originTurnId,
          sessionId: work.sessionId,
          toolCallId: result.toolCallId,
        });
        if (
          committed.toolName !== result.toolName ||
          committed.resultSha256 !== result.resultSha256
        ) invalid("project_work_result_reference_mismatch");
        evidence.set(result.resultRef, committed);
      });
    }
    return evidence;
  }

}

function invalid(message: string): never {
  throw new Error(message);
}
