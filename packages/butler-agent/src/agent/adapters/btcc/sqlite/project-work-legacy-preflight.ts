import type { Database } from "bun:sqlite";
import type { WorkTurnScope } from "../../../btcc/work/index.ts";
import type { ResolvedProjectWorkScope } from "../project-ledger/index.ts";
import { guidedWorkRecordId } from "./guided-work-record-id.ts";

type LegacyImportIdentity = {
  import_id: string;
  legacy_program_id: string;
  source_revision: string;
  work_id: string;
  session_id: string;
  scope_kind: string;
  scope_ref: string;
  source_authority: string;
};

/** Rejects malformed or globally colliding import identity before publication. */
export function validateLegacyImportPreflight(
  db: Database,
  input: { scope: WorkTurnScope; resolvedScope: ResolvedProjectWorkScope },
  workId: string,
  sourceProgramId: string,
  prior: LegacyImportIdentity | null,
): void {
  const expectedId = guidedWorkRecordId(
    "legacy-import",
    `${sourceProgramId}\0${input.scope.sessionId}` +
      `\0${input.resolvedScope.appProjectId}`,
  );
  const collision = db.query<LegacyImportIdentity, [string]>(`
    SELECT import_id, legacy_program_id, source_revision, work_id,
      session_id, scope_kind, scope_ref, source_authority
    FROM btcc_guided_work_legacy_imports WHERE import_id = ?
  `).get(expectedId);
  const tupleRows = db.query<LegacyImportIdentity, [string, string, string]>(`
    SELECT import_id, legacy_program_id, source_revision, work_id,
      session_id, scope_kind, scope_ref, source_authority
    FROM btcc_guided_work_legacy_imports
    WHERE legacy_program_id = ? AND session_id = ?
      AND scope_kind = 'project' AND scope_ref = ?
  `).all(
    sourceProgramId,
    input.scope.sessionId,
    input.resolvedScope.appProjectId,
  );
  if (!prior) {
    if (collision || tupleRows.length > 0) invalid();
    return;
  }
  if (
    prior.import_id !== expectedId || collision?.work_id !== workId ||
    prior.legacy_program_id !== sourceProgramId ||
    prior.session_id !== input.scope.sessionId || prior.scope_kind !== "project" ||
    prior.scope_ref !== input.resolvedScope.appProjectId ||
    prior.source_authority !== "project_ledger" || prior.work_id !== workId ||
    !/^[a-f0-9]{64}$/u.test(prior.source_revision) ||
    tupleRows.length !== 1 || tupleRows[0]!.import_id !== expectedId ||
    tupleRows[0]!.work_id !== workId
  ) invalid();
}

export function legacySemanticOriginTurnIds(
  db: Database,
  workId: string,
): string[] {
  const tables = [
    "btcc_guided_work_plan_revisions",
    "btcc_guided_work_checkpoint_revisions",
    "btcc_guided_work_review_revisions",
    "btcc_guided_work_disposition_revisions",
  ];
  return tables.flatMap((table) => db.query<{ origin_turn_id: string }, [string]>(
    `SELECT origin_turn_id FROM ${table} WHERE work_id = ?`,
  ).all(workId).map((row) => row.origin_turn_id));
}

function invalid(): never {
  throw new Error("project_work_legacy_identity_conflict");
}
