import type { Database } from "bun:sqlite";
import type {
  LegacyOpenWorkImportResult,
  WorkTurnScope,
} from "../../../btcc/work/index.ts";
import { stableJson } from "./identity.ts";
import type { GuidedWorkTurn } from "./guided-work-records.ts";
import type { LegacyWorkProjection } from "./guided-work-legacy-projection.ts";
import { guidedWorkRecordId } from "./guided-work-record-id.ts";
import { bindLegacyEffectBlockersToWork } from
  "./guided-work-effect-blockers.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";

type LegacyImportRow = {
  legacy_program_id: string;
  session_id: string;
  scope_kind: "session" | "project";
  scope_ref: string;
  work_id: string;
};

export type LegacyWorkImportCandidate = {
  sourceProgramId: string;
  sourceAuthority: "session_sqlite" | "project_ledger";
  sourceRevision: string;
  projection: LegacyWorkProjection;
  origin: GuidedWorkTurn;
};

export class GuidedWorkLegacyWriter {
  constructor(
    private readonly db: Database,
    private readonly reader: GuidedWorkViewReader,
  ) {}

  import(
    scope: WorkTurnScope,
    candidate: LegacyWorkImportCandidate,
  ): LegacyOpenWorkImportResult | null {
    // Legacy continuity may be retried on a stopped Turn, but it must not
    // create/replay Work rows or effect blockers after the execution fence
    // changes.  Reads remain available through the normal view reader.
    this.reader.relationTurn(scope);
    if (candidate.origin.session_id !== scope.sessionId) {
      throw new Error("Legacy Work origin belongs to another Session");
    }
    const importId = legacyImportId(candidate.sourceProgramId, scope);
    const replay = this.replay(scope, candidate.sourceProgramId);
    if (replay) return replay;
    const head = this.reader.sessionHead(scope.sessionId);
    if (head?.status === "open" || head?.status === "blocked") return null;

    const workId = guidedWorkRecordId("work", importId);
    const planId = candidate.projection.plan
      ? guidedWorkRecordId("plan", importId)
      : null;
    const checkpointId = candidate.projection.checkpoint
      ? guidedWorkRecordId("checkpoint", importId)
      : null;
    const now = new Date().toISOString();
    const scopeKind = scope.projectRef ? "project" : "session";
    const scopeRef = scope.projectRef ?? scope.sessionId;
    this.db.query(`
      INSERT INTO btcc_guided_works (
        work_id, session_id, scope_kind, scope_ref, origin_turn_id,
        origin_message_id, objective, status, current_plan_revision_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
    `).run(
      workId,
      scope.sessionId,
      scopeKind,
      scopeRef,
      candidate.origin.turn_id,
      candidate.origin.original_message_id,
      candidate.projection.objective,
      planId,
      now,
      now,
    );
    if (candidate.projection.plan && planId) {
      this.db.query(`
        INSERT INTO btcc_guided_work_plan_revisions (
          plan_revision_id, work_id, revision, objective, governing_refs_json,
          actions_json, checks_json, origin_turn_id, created_at
        ) VALUES (?, ?, 1, ?, '[]', ?, ?, ?, ?)
      `).run(
        planId,
        workId,
        candidate.projection.objective,
        stableJson(candidate.projection.plan.actions),
        stableJson(candidate.projection.plan.checks),
        candidate.origin.turn_id,
        now,
      );
    }
    if (candidate.projection.checkpoint && checkpointId && planId && candidate.projection.plan) {
      this.db.query(`
        INSERT INTO btcc_guided_work_checkpoint_revisions (
          checkpoint_revision_id, work_id, revision, plan_revision_id, stage,
          public_summary, next_step, action_states_json, result_sequence,
          origin_turn_id, created_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        checkpointId,
        workId,
        planId,
        candidate.projection.checkpoint.stage,
        candidate.projection.checkpoint.publicSummary,
        candidate.projection.checkpoint.nextStep,
        stableJson(candidate.projection.checkpoint.actionProgress),
        candidate.origin.turn_id,
        now,
      );
    }
    this.db.query(`
      INSERT INTO btcc_guided_work_session_heads (session_id, work_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        work_id = excluded.work_id,
        updated_at = excluded.updated_at
    `).run(scope.sessionId, workId, now);
    this.db.query(`
      INSERT INTO btcc_guided_work_legacy_imports (
        import_id, legacy_program_id, session_id, scope_kind, scope_ref,
        source_authority, source_revision, work_id, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      importId,
      candidate.sourceProgramId,
      scope.sessionId,
      scopeKind,
      scopeRef,
      candidate.sourceAuthority,
      candidate.sourceRevision,
      workId,
      now,
    );
    bindLegacyEffectBlockersToWork(this.db, {
      workId,
      sessionId: scope.sessionId,
      sourceProgramId: candidate.sourceProgramId,
      sourceTurnId: candidate.origin.turn_id,
    });
    return {
      sourceProgramId: candidate.sourceProgramId,
      imported: true,
      work: this.reader.view(workId),
    };
  }

  replay(
    scope: WorkTurnScope,
    sourceProgramId: string,
  ): LegacyOpenWorkImportResult | null {
    this.reader.relationTurn(scope);
    const importId = legacyImportId(sourceProgramId, scope);
    const row = this.db.query<LegacyImportRow, [string]>(`
      SELECT legacy_program_id, session_id, scope_kind, scope_ref, work_id
      FROM btcc_guided_work_legacy_imports WHERE import_id = ?
    `).get(importId);
    if (!row) return null;
    const scopeKind = scope.projectRef ? "project" : "session";
    const scopeRef = scope.projectRef ?? scope.sessionId;
    if (
      row.legacy_program_id !== sourceProgramId ||
      row.session_id !== scope.sessionId ||
      row.scope_kind !== scopeKind ||
      row.scope_ref !== scopeRef
    ) {
      throw new Error("Legacy Work import identity conflict");
    }
    bindLegacyEffectBlockersToWork(this.db, {
      workId: row.work_id,
      sessionId: scope.sessionId,
      sourceProgramId,
    });
    return {
      sourceProgramId: row.legacy_program_id,
      imported: false,
      work: this.reader.view(row.work_id),
    };
  }
}

export function legacyImportId(programId: string, scope: WorkTurnScope): string {
  return guidedWorkRecordId(
    "legacy-import",
    `${programId}\0${scope.sessionId}\0${scope.projectRef ?? ""}`,
  );
}
