import type { Database } from "bun:sqlite";
import type {
  LegacyOpenWorkImportResult,
  LegacyProjectWorkSnapshot,
  WorkTurnScope,
} from "../../../btcc/work/index.ts";
import type { GuidedWorkTurn } from "./guided-work-records.ts";
import { projectLegacyOpenWork } from "./guided-work-legacy-projection.ts";
import { GuidedWorkLegacyWriter } from "./guided-work-legacy-writer.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";

type ManagedTurnLocator = GuidedWorkTurn & {
  managed_state_json: string | null;
};

export class GuidedWorkLegacyProjectImporter {
  private readonly writer: GuidedWorkLegacyWriter;

  constructor(
    private readonly db: Database,
    private readonly reader: GuidedWorkViewReader,
  ) {
    this.writer = new GuidedWorkLegacyWriter(db, reader);
  }

  locateProgramIds(scope: WorkTurnScope): string[] {
    this.reader.turn(scope);
    if (!scope.projectRef || !this.hasLocatorTables()) return [];
    const projected = new Set(
      this.db.query<{ program_id: string }, []>(`
        SELECT program_id FROM btcc_project_program_projections
        ORDER BY program_id
      `).all().map((row) => row.program_id),
    );
    const ids = this.managedTurns(scope.sessionId)
      .map((row) => readProgramId(row.managed_state_json))
      .filter((programId): programId is string =>
        Boolean(programId && projected.has(programId)));
    return [...new Set(ids)].sort();
  }

  replay(
    scope: WorkTurnScope,
    programIds: readonly string[],
  ): LegacyOpenWorkImportResult | null {
    const replays = programIds
      .map((programId) => this.writer.replay(scope, programId))
      .filter((result): result is LegacyOpenWorkImportResult => Boolean(result));
    if (replays.length > 1) {
      throw new Error("Project Work import has multiple existing R3 Works");
    }
    return replays[0] ?? null;
  }

  import(
    scope: WorkTurnScope,
    snapshot: LegacyProjectWorkSnapshot,
  ): LegacyOpenWorkImportResult | null {
    const fallbackTurn = this.reader.turn(scope);
    if (!scope.projectRef) {
      throw new Error("Project Work import requires a Project scope");
    }
    if (!this.locateProgramIds(scope).includes(snapshot.sourceProgramId)) {
      throw new Error("Project Work import lost its Session Program locator");
    }
    const records = new Map(
      snapshot.referencedRecords.map((record) => [record.recordId, record.content]),
    );
    const projection = projectLegacyOpenWork({
      goal: snapshot.goalContract,
      plan: snapshot.plan,
      works: snapshot.works,
      tasks: snapshot.tasks,
      readRecord: (recordId) => records.get(recordId) ?? null,
    });
    const origin = this.findOriginTurn(
      scope.sessionId,
      snapshot.sourceProgramId,
      projection.originalMessageId,
    ) ?? fallbackTurn;
    return this.writer.import(scope, {
      sourceProgramId: snapshot.sourceProgramId,
      sourceAuthority: "project_ledger",
      sourceRevision: snapshot.sourceRevision,
      projection,
      origin,
    });
  }

  private findOriginTurn(
    sessionId: string,
    programId: string,
    originalMessageId?: string,
  ): GuidedWorkTurn | null {
    if (originalMessageId) {
      const exact = this.db.query<GuidedWorkTurn, [string, string]>(`
        SELECT turn_id, session_id, original_message_id, original_message
        FROM btcc_turns
        WHERE session_id = ? AND original_message_id = ?
        ORDER BY rowid LIMIT 1
      `).get(sessionId, originalMessageId);
      if (exact) return exact;
    }
    return this.managedTurns(sessionId).find((row) =>
      readProgramId(row.managed_state_json) === programId) ?? null;
  }

  private managedTurns(sessionId: string): ManagedTurnLocator[] {
    return this.db.query<ManagedTurnLocator, [string]>(`
      SELECT turn_id, session_id, original_message_id, original_message,
        managed_state_json
      FROM btcc_turns
      WHERE session_id = ? AND route = 'managed'
      ORDER BY rowid DESC
    `).all(sessionId);
  }

  private hasLocatorTables(): boolean {
    const required = ["btcc_turns", "btcc_project_program_projections"];
    const count = this.db.query<{ count: number }, string[]>(`
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE type = 'table' AND name IN (${required.map(() => "?").join(", ")})
    `).get(...required)?.count ?? 0;
    return count === required.length;
  }
}

function readProgramId(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { programId?: unknown };
    return typeof parsed.programId === "string" && parsed.programId
      ? parsed.programId
      : null;
  } catch {
    return null;
  }
}
