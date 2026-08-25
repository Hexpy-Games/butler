import type { Database } from "bun:sqlite";
import type {
  ProjectWorkLegacyObservation,
  ProjectWorkLegacyRuntime,
  ProjectWorkLegacySnapshot,
  ResolvedProjectWorkScope,
} from "../project-ledger/index.ts";
import type { WorkTurnScope } from "../../../btcc/work/index.ts";
import type { LegacyProjectWorkSource } from "../../../btcc/work/index.ts";
import { guidedWorkRecordId } from "./guided-work-record-id.ts";
import {
  captureProjectWorkLegacySnapshot,
  findLegacyProjectWorks,
  hasLegacySemanticRows,
  readLegacyImportRow,
  type LegacyWorkLocator,
} from "./project-work-legacy-snapshot.ts";
import { validateLegacyImportPreflight } from "./project-work-legacy-preflight.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";
import { GuidedWorkLegacyProjectImporter } from "./guided-work-legacy-project-importer.ts";
import {
  captureRawR2ProjectWorkSnapshot,
  revalidateRawR2ProjectWorkSource,
} from "./project-work-legacy-r2.ts";

/** Cleans legacy semantic rows only after exact Project observation. */
export class SqliteProjectWorkLegacyRuntime
implements ProjectWorkLegacyRuntime {
  private readonly reader: GuidedWorkViewReader;

  constructor(
    private readonly db: Database,
    private readonly rawR2Source?: LegacyProjectWorkSource,
  ) {
    this.reader = new GuidedWorkViewReader(db);
  }

  readImportObservation(input: {
    scope: WorkTurnScope;
    resolvedScope: ResolvedProjectWorkScope;
  }): ProjectWorkLegacyObservation | null {
    this.reader.turn(input.scope);
    const rows = findLegacyProjectWorks(this.db, input.scope, input.resolvedScope);
    if (rows.length > 1) conflict("project_work_legacy_multiple_open_works");
    const row = rows[0];
    if (!row || !row.ledger_project_id || !row.canonical_head_sha256) return null;
    const observation = readLegacyImportRow(this.db, row.work_id);
    if (!observation || hasLegacySemanticRows(this.db, row.work_id)) return null;
    if (
      row.ledger_project_id !== input.resolvedScope.ledgerProjectId ||
      !/^[a-f0-9]{64}$/u.test(row.canonical_head_sha256) ||
      !/^[a-f0-9]{64}$/u.test(observation.source_revision) ||
      observation.session_id !== input.scope.sessionId ||
      observation.scope_kind !== "project" ||
      observation.scope_ref !== input.resolvedScope.appProjectId ||
      observation.source_authority !== "project_ledger" ||
      observation.work_id !== row.work_id
    ) conflict("project_work_legacy_observation_invalid");
    validateLegacyImportPreflight(
      this.db,
      input,
      row.work_id,
      observation.legacy_program_id,
      observation,
    );
    return {
      sourceProgramId: observation.legacy_program_id,
      sourceSha256: observation.source_revision,
      workId: row.work_id,
    };
  }

  captureStableSnapshot(input: {
    scope: WorkTurnScope;
    resolvedScope: ResolvedProjectWorkScope;
  }): ProjectWorkLegacySnapshot | null | Promise<ProjectWorkLegacySnapshot | null> {
    const current = this.db.transaction(() =>
      captureProjectWorkLegacySnapshot(this.db, this.reader, input),
    ).immediate();
    if (current || !this.rawR2Source) return current;
    return this.captureRawR2(input);
  }

  async revalidateBeforeObservation(input: {
    scope: WorkTurnScope;
    resolvedScope: ResolvedProjectWorkScope;
    snapshot: ProjectWorkLegacySnapshot;
  }): Promise<void> {
    if (input.snapshot.sourceKind !== "raw_r2") return;
    const source = this.rawR2Source;
    if (!source)
      conflict("project_work_legacy_source_unavailable");
    await revalidateRawR2ProjectWorkSource({
      db: this.db,
      reader: this.reader,
      source,
      ...input,
    });
  }

  observeImported(
    input: Parameters<ProjectWorkLegacyRuntime["observeImported"]>[0],
  ): void {
    if (!/^[a-f0-9]{64}$/u.test(input.canonicalHeadSha256))
      conflict("project_work_legacy_observation_invalid");
    this.db.transaction(() => {
      if (input.snapshot.sourceKind === "raw_r2") {
        this.validateRawR2Observation(input);
        input.verifyResults();
        const work = this.observedWork(input.snapshot.work.workId)!;
        const prior = readLegacyImportRow(this.db, work.work_id);
        const importId = prior?.import_id ?? guidedWorkRecordId(
          "legacy-import",
          `${input.snapshot.sourceProgramId}\0${input.scope.sessionId}` +
            `\0${input.resolvedScope.appProjectId}`,
        );
        this.recordObservation(input, importId, work.work_id);
        this.removeSemanticAuthority(work.work_id);
        return;
      }
      const current = captureProjectWorkLegacySnapshot(this.db, this.reader, {
        scope: input.scope,
        resolvedScope: input.resolvedScope,
      });
      if (!current || current.sourceSha256 !== input.snapshot.sourceSha256)
        conflict("project_work_legacy_source_changed");
      input.verifyResults();
      const work = this.observedWork(input.snapshot.work.workId);
      if (
        !work || work.session_id !== input.scope.sessionId ||
        work.scope_kind !== "project" ||
        work.scope_ref !== input.resolvedScope.appProjectId ||
        work.ledger_project_id !== input.resolvedScope.ledgerProjectId ||
        work.canonical_head_sha256 !== input.canonicalHeadSha256
      ) conflict("project_work_legacy_project_not_observed");
      const prior = readLegacyImportRow(this.db, work.work_id);
      const importId = prior?.import_id ?? guidedWorkRecordId(
        "legacy-import",
        `${input.snapshot.sourceProgramId}\0${input.scope.sessionId}` +
        `\0${input.resolvedScope.appProjectId}`,
      );
      if (prior && (
        prior.legacy_program_id !== input.snapshot.sourceProgramId ||
        prior.session_id !== input.scope.sessionId ||
        prior.scope_kind !== "project" ||
        prior.scope_ref !== input.resolvedScope.appProjectId ||
        prior.source_authority !== "project_ledger" ||
        prior.work_id !== work.work_id
      )) conflict("project_work_legacy_identity_conflict");
      if (!prior && this.importIdExists(importId))
        conflict("project_work_legacy_identity_conflict");
      this.recordObservation(input, importId, work.work_id);
      this.removeSemanticAuthority(work.work_id);
    }).immediate();
  }

  private async captureRawR2(input: {
    scope: WorkTurnScope;
    resolvedScope: ResolvedProjectWorkScope;
  }): Promise<ProjectWorkLegacySnapshot | null> {
    const importer = new GuidedWorkLegacyProjectImporter(this.db, this.reader);
    const programIds = this.db.transaction(() => importer.locateProgramIds(input.scope))
      .immediate();
    if (programIds.length === 0) return null;
    const source = await this.rawR2Source!.loadOpenWork({
      projectRef: input.scope.projectRef ?? input.resolvedScope.appProjectId,
      programIds,
    });
    if (!source) return null;
    return this.db.transaction(() => {
      const currentIds = importer.locateProgramIds(input.scope);
      if (stableIds(currentIds) !== stableIds(programIds))
        conflict("project_work_legacy_source_changed");
      return captureRawR2ProjectWorkSnapshot(this.db, {
        ...input, source, sourceProgramIds: programIds,
      });
    }).immediate();
  }

  private validateRawR2Observation(
    input: Parameters<ProjectWorkLegacyRuntime["observeImported"]>[0],
  ): void {
    const work = this.observedWork(input.snapshot.work.workId);
    if (
      !work || work.session_id !== input.scope.sessionId ||
      work.scope_kind !== "project" ||
      work.scope_ref !== input.resolvedScope.appProjectId ||
      work.ledger_project_id !== input.resolvedScope.ledgerProjectId ||
      work.canonical_head_sha256 !== input.canonicalHeadSha256 ||
      hasLegacySemanticRows(this.db, work.work_id)
    ) conflict("project_work_legacy_project_not_observed");
    for (const expected of input.snapshot.bindings) {
      const binding = this.db.query<{
        turn_id: string;
        session_id: string;
        work_id: string;
        revision: number;
        is_current: number;
      }, [string]>(`
        SELECT turn_id, session_id, work_id, revision, is_current
        FROM btcc_guided_turn_work_bindings WHERE binding_revision_id = ?
      `).get(expected.bindingRevisionId);
      if (
        !binding || binding.turn_id !== expected.turnId ||
        binding.session_id !== input.scope.sessionId ||
        binding.work_id !== work.work_id || binding.revision !== expected.revision ||
        binding.is_current !== 1
      ) conflict("project_work_legacy_binding_invalid");
    }
    const origin = input.snapshot.turns.find(
      (turn) => turn.turnId === input.snapshot.work.origin.turnId,
    );
    const row = this.db.query<{
      session_id: string;
      original_message_id: string;
    }, [string]>(`
      SELECT session_id, original_message_id FROM btcc_turns WHERE turn_id = ?
    `).get(input.snapshot.work.origin.turnId);
    if (
      !origin || !row || row.session_id !== input.scope.sessionId ||
      row.original_message_id !== origin.originalMessageId ||
      row.original_message_id !== input.snapshot.work.origin.messageId
    ) conflict("project_work_legacy_origin_message_invalid");
  }

  private observedWork(workId: string): LegacyWorkLocator | null {
    return this.db.query<LegacyWorkLocator, [string]>(`
      SELECT work_id, session_id, scope_kind, scope_ref, ledger_project_id,
        canonical_head_sha256 FROM btcc_guided_works WHERE work_id = ?
    `).get(workId) ?? null;
  }

  private recordObservation(
    input: Parameters<ProjectWorkLegacyRuntime["observeImported"]>[0],
    importId: string,
    workId: string,
  ): void {
    if (readLegacyImportRow(this.db, workId)) {
      const updated = this.db.query(`
        UPDATE btcc_guided_work_legacy_imports
        SET source_revision = ?, imported_at = ?
        WHERE import_id = ? AND legacy_program_id = ? AND session_id = ?
          AND scope_kind = 'project' AND scope_ref = ?
          AND source_authority = 'project_ledger' AND work_id = ?
      `).run(
        input.snapshot.sourceSha256,
        new Date().toISOString(),
        importId,
        input.snapshot.sourceProgramId,
        input.scope.sessionId,
        input.resolvedScope.appProjectId,
        workId,
      );
      if (updated.changes !== 1)
        conflict("project_work_legacy_identity_conflict");
      return;
    }
    this.db.query(`
      INSERT INTO btcc_guided_work_legacy_imports (
        import_id, legacy_program_id, session_id, scope_kind, scope_ref,
        source_authority, source_revision, work_id, imported_at
      ) VALUES (?, ?, ?, 'project', ?, 'project_ledger', ?, ?, ?)
    `).run(
      importId,
      input.snapshot.sourceProgramId,
      input.scope.sessionId,
      input.resolvedScope.appProjectId,
      input.snapshot.sourceSha256,
      workId,
      new Date().toISOString(),
    );
  }

  private importIdExists(importId: string): boolean {
    return Boolean(this.db.query<{ present: number }, [string]>(`
      SELECT 1 AS present FROM btcc_guided_work_legacy_imports
      WHERE import_id = ? LIMIT 1
    `).get(importId));
  }

  private removeSemanticAuthority(workId: string): void {
    for (const table of [
      "btcc_guided_work_plan_revisions",
      "btcc_guided_work_checkpoint_revisions",
      "btcc_guided_work_review_revisions",
      "btcc_guided_work_disposition_revisions",
      "btcc_guided_work_closeout_diagnostics",
      "btcc_guided_work_disposition_commands",
      "btcc_guided_work_mutations",
      "btcc_guided_work_relation_commands",
    ]) this.db.query(`DELETE FROM ${table} WHERE work_id = ?`).run(workId);
  }
}

function conflict(code: string): never { throw new Error(code); }

function stableIds(ids: readonly string[]): string {
  return [...ids].sort().join("\0");
}
