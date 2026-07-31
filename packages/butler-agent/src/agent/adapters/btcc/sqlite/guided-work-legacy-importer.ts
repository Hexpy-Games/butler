import type { Database } from "bun:sqlite";
import type {
  LegacyOpenWorkImportResult,
  WorkTurnScope,
} from "../../../btcc/durable-work/index.ts";
import type { GuidedWorkTurn } from "./guided-work-records.ts";
import {
  projectLegacyOpenWork,
  type LegacyWorkRecordSnapshot,
} from "./guided-work-legacy-projection.ts";
import { guidedWorkRecordId } from "./guided-work-record-id.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";

type LegacyProgramRow = {
  program_id: string;
  session_id: string;
  scope_kind: "session" | "project";
  scope_id: string;
  goal_contract_ref: string;
  accepted_plan_ref: string | null;
};

type LegacyImportRow = {
  legacy_program_id: string;
  session_id: string;
  scope_kind: "session" | "project";
  scope_ref: string;
  work_id: string;
};

type LegacyItemRow = {
  item_id: string;
  record_ref: string;
  status: string;
};

export class GuidedWorkLegacyImporter {
  constructor(
    private readonly db: Database,
    private readonly reader: GuidedWorkViewReader,
  ) {}

  import(scope: WorkTurnScope): LegacyOpenWorkImportResult | null {
    const fallbackTurn = this.reader.turn(scope);
    const program = this.findOpenProgram(scope);
    if (!program) return null;
    const importId = legacyImportId(program.program_id, scope);
    const replay = this.replay(importId, program, scope);
    if (replay) return replay;
    const head = this.reader.sessionHead(scope.sessionId);
    if (head?.status === "open" || head?.status === "blocked") return null;

    const goal = this.readRecord(program.goal_contract_ref);
    const plan = program.accepted_plan_ref
      ? this.readRecord(program.accepted_plan_ref)
      : null;
    const works = this.loadItems("work", program.program_id);
    const tasks = this.loadItems("task", program.program_id);
    const projection = projectLegacyOpenWork({
      goal,
      plan,
      works,
      tasks,
      readRecord: (recordId) => this.readRecord(recordId),
    });
    const origin = this.findOriginTurn(program, projection.originalMessageId)
      ?? fallbackTurn;
    const workId = guidedWorkRecordId("work", importId);
    const planId = projection.plan
      ? guidedWorkRecordId("plan", importId)
      : null;
    const checkpointId = projection.checkpoint
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
      origin.turn_id,
      origin.original_message_id,
      projection.objective,
      planId,
      now,
      now,
    );
    if (projection.plan && planId) {
      this.db.query(`
        INSERT INTO btcc_guided_work_plan_revisions (
          plan_revision_id, work_id, revision, objective, actions_json,
          checks_json, origin_turn_id, created_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        planId,
        workId,
        projection.objective,
        JSON.stringify(projection.plan.actions),
        JSON.stringify(projection.plan.checks),
        origin.turn_id,
        now,
      );
    }
    if (projection.checkpoint && checkpointId) {
      this.db.query(`
        INSERT INTO btcc_guided_work_checkpoint_revisions (
          checkpoint_revision_id, work_id, revision, stage, public_summary,
          next_step, result_sequence, origin_turn_id, created_at
        ) VALUES (?, ?, 1, ?, ?, ?, 0, ?, ?)
      `).run(
        checkpointId,
        workId,
        projection.checkpoint.stage,
        projection.checkpoint.publicSummary,
        projection.checkpoint.nextStep,
        origin.turn_id,
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
        work_id, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      importId,
      program.program_id,
      scope.sessionId,
      scopeKind,
      scopeRef,
      workId,
      now,
    );
    return {
      sourceProgramId: program.program_id,
      imported: true,
      work: this.reader.view(workId),
    };
  }

  private findOpenProgram(scope: WorkTurnScope): LegacyProgramRow | null {
    if (scope.projectRef || !this.hasLegacyWorkTables()) return null;
    const order = `
      ORDER BY (
        SELECT MAX(m.rowid) FROM btcc_ledger_mutations m
        WHERE m.program_id = program.program_id
      ) DESC, program.rowid DESC
      LIMIT 1
    `;
    return this.db.query<LegacyProgramRow, [string, string]>(`
      SELECT program_id, session_id, scope_kind, scope_id,
        goal_contract_ref, accepted_plan_ref
      FROM btcc_programs program
      WHERE scope_kind = 'session' AND scope_id = ? AND session_id = ?
        AND frontier NOT IN ('closed', 'cancelled')
      ${order}
    `).get(scope.sessionId, scope.sessionId);
  }

  private hasLegacyWorkTables(): boolean {
    const required = [
      "btcc_programs",
      "btcc_work_items",
      "btcc_tasks",
      "btcc_records",
      "btcc_ledger_mutations",
    ];
    const count = this.db.query<{ count: number }, string[]>(`
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE type = 'table' AND name IN (${required.map(() => "?").join(", ")})
    `).get(...required)?.count ?? 0;
    return count === required.length;
  }

  private replay(
    importId: string,
    program: LegacyProgramRow,
    scope: WorkTurnScope,
  ): LegacyOpenWorkImportResult | null {
    const row = this.db.query<LegacyImportRow, [string]>(`
      SELECT legacy_program_id, session_id, scope_kind, scope_ref, work_id
      FROM btcc_guided_work_legacy_imports WHERE import_id = ?
    `).get(importId);
    if (!row) return null;
    const scopeKind = scope.projectRef ? "project" : "session";
    const scopeRef = scope.projectRef ?? scope.sessionId;
    if (
      row.legacy_program_id !== program.program_id ||
      row.session_id !== scope.sessionId ||
      row.scope_kind !== scopeKind ||
      row.scope_ref !== scopeRef
    ) {
      throw new Error("Legacy Work import identity conflict");
    }
    return {
      sourceProgramId: row.legacy_program_id,
      imported: false,
      work: this.reader.view(row.work_id),
    };
  }

  private loadItems(
    kind: "work" | "task",
    programId: string,
  ): LegacyWorkRecordSnapshot[] {
    const table = kind === "work" ? "btcc_work_items" : "btcc_tasks";
    const idColumn = kind === "work" ? "work_id" : "task_id";
    const refColumn = kind === "work" ? "work_ref" : "task_ref";
    const rows = this.db.query<LegacyItemRow, [string]>(`
      SELECT ${idColumn} AS item_id, ${refColumn} AS record_ref, status
      FROM ${table} WHERE program_id = ? AND is_active = 1 ORDER BY rowid
    `).all(programId);
    return rows.map((row) => {
      const recordId = storedReferenceId(row.record_ref) ?? row.item_id;
      return {
        recordId,
        status: row.status,
        content: this.readRecord(recordId),
      };
    });
  }

  private findOriginTurn(
    program: LegacyProgramRow,
    originalMessageId?: string,
  ): GuidedWorkTurn | null {
    const exact = this.db.query<
      GuidedWorkTurn,
      [string, string, string, string]
    >(`
      SELECT turn_id, session_id, original_message_id, original_message
      FROM btcc_turns
      WHERE session_id = ?
        AND (goal_contract_ref = ? OR original_message_id = ?)
      ORDER BY CASE WHEN original_message_id = ? THEN 0 ELSE 1 END, rowid
      LIMIT 1
    `).get(
      program.session_id,
      program.goal_contract_ref,
      originalMessageId ?? "",
      originalMessageId ?? "",
    );
    if (exact) return exact;
    const rows = this.db.query<GuidedWorkTurn & {
      managed_state_json: string | null;
    }, [string]>(`
      SELECT turn_id, session_id, original_message_id, original_message,
        managed_state_json
      FROM btcc_turns
      WHERE session_id = ? AND route = 'managed'
      ORDER BY rowid DESC
    `).all(program.session_id);
    return rows.find((row) =>
      readProgramId(row.managed_state_json) === program.program_id) ?? null;
  }

  private readRecord(recordId: string): unknown {
    const row = this.db.query<{ content_json: string }, [string]>(`
      SELECT content_json FROM btcc_records WHERE record_id = ?
    `).get(recordId);
    if (!row) return null;
    try {
      return JSON.parse(row.content_json) as unknown;
    } catch {
      return null;
    }
  }
}

function legacyImportId(programId: string, scope: WorkTurnScope): string {
  return guidedWorkRecordId(
    "legacy-import",
    `${programId}\0${scope.sessionId}\0${scope.projectRef ?? ""}`,
  );
}

function storedReferenceId(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id ? parsed.id : null;
  } catch {
    return null;
  }
}

function readProgramId(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { programId?: unknown };
    return typeof parsed.programId === "string" ? parsed.programId : null;
  } catch {
    return null;
  }
}
