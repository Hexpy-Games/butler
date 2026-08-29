import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWorkActionUpdates,
  createDurableWorkService,
  dispositionMaterialFingerprint,
  type DurableWorkView,
  type LegacyProjectWorkSource,
  type RecordWorkDispositionCommand,
} from "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import { createPrincipalAuthority } from "../../packages/butler-agent/src/agent/btcc/authority/index.ts";
import {
  createProjectWorkStore,
  type ProjectWorkOperationIdentity,
  type ProjectWorkRuntimeProjection,
} from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { captureMaterialSnapshot } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-work-material-snapshot.ts";
import { loadProjectLedgerCore } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-ledger-core.ts";
import { createProjectLedgerLegacyWorkSource } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/legacy-project-work-source.ts";
import { SqlitePrincipalAuthorityRepository } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/authority-repository.ts";
import { SqliteGuidedWorkStore } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/guided-work-store.ts";
import { SqliteProjectWorkLegacyRuntime } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/project-work-legacy-runtime.ts";
import { SqliteProjectWorkResultRuntime } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/project-work-result-runtime.ts";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { guidedWorkRecordId } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/guided-work-record-id.ts";
import {
  publishReviewedProgram,
  seedProjectLocator,
} from "./support/btcc-r3-project-legacy-import-fixture.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("recovers R2-projected R3 Work across both crash boundaries to one fixed point", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-project-legacy-convergence-"));
  roots.push(root);
  const butlerData = join(root, "data");
  const requested = join(butlerData, "project-ledger", "projects", "ledger-project");
  mkdirSync(requested, { recursive: true });
  const ledgerRoot = realpathSync(requested);
  writeFileSync(join(ledgerRoot, "project.json"), `${JSON.stringify({
    schema: "project-ledger.project.v1",
    id: "ledger-project",
    name: "Legacy convergence",
    status: "active",
  }, null, 2)}\n`);
  writeFileSync(join(ledgerRoot, "ledger.jsonl"), "");
  const core = await loadProjectLedgerCore();
  core.writeIndex(ledgerRoot);

  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    insertTurn(db);
    const scope = {
      turnId: "turn-legacy",
      sessionId: "session-legacy",
      projectRef: "app-project",
    };
    const sessionService = createDurableWorkService(new SqliteGuidedWorkStore(
      db,
      createPrincipalAuthority(new SqlitePrincipalAuthorityRepository(db)),
    ));
    await sessionService.startWork({
      ...scope,
      mutationCallId: "legacy-start",
      objective: "Converge the old Project Work",
    });
    const source = await sessionService.replacePlan({
      ...scope,
      mutationCallId: "legacy-plan",
      objective: "Converge the old Project Work",
      actions: [{ actionKey: "publish", description: "Publish", dependencyKeys: [] }],
      checks: ["fixed point"],
    });
    await sessionService.recordReview({
      ...scope,
      mutationCallId: "legacy-plan-review",
      subject: "plan",
      verdict: "accept",
      summary: "The legacy plan is complete.",
      corrections: [],
    });
    const currentSnapshot = await new SqliteProjectWorkLegacyRuntime(db)
      .captureStableSnapshot({
        scope,
        resolvedScope: {
          appProjectId: "app-project",
          ledgerProjectId: "ledger-project",
          ledgerRoot,
        },
      });
    expect(currentSnapshot).toMatchObject({
      sourceProgramId: `current-r3:${source.workId}`,
      work: { workId: source.workId },
      plans: [{ revision: 1 }],
    });
    expect(currentSnapshot?.checkpoints.map((item) => item.checkpoint.revision))
      .toEqual([1, 2, 3, 4]);
    db.query(`INSERT INTO btcc_guided_works (
      work_id, session_id, scope_kind, scope_ref, origin_turn_id,
      origin_message_id, objective, status, current_plan_revision_id,
      created_at, updated_at
    ) SELECT 'conflicting-work', session_id, scope_kind, scope_ref,
      origin_turn_id, origin_message_id, objective, status, NULL,
      created_at, updated_at FROM btcc_guided_works WHERE work_id = ?`)
      .run(source.workId);
    expect(() => new SqliteProjectWorkLegacyRuntime(db).captureStableSnapshot({
      scope,
      resolvedScope: {
        appProjectId: "app-project",
        ledgerProjectId: "ledger-project",
        ledgerRoot,
      },
    })).toThrow("project_work_legacy_multiple_open_works");
    db.query("DELETE FROM btcc_guided_works WHERE work_id = 'conflicting-work'").run();
    const r2ImportId = guidedWorkRecordId(
      "legacy-import",
      "program-r2\0session-legacy\0app-project",
    );
    db.query(`INSERT INTO btcc_guided_work_legacy_imports (
      import_id, legacy_program_id, session_id, scope_kind, scope_ref,
      source_authority, source_revision, work_id, imported_at
    ) VALUES (?, 'program-r2', 'session-legacy', 'project',
      'app-project', 'project_ledger', ?, ?, '2026-08-25T00:00:00.000Z')`)
      .run(r2ImportId, "a".repeat(64), source.workId);
    const resultJson = JSON.stringify({ ok: true, output: { migrated: true } });
    const resultSha256 = sha(resultJson);
    db.query(`INSERT INTO btcc_guided_tool_calls (
      call_id, turn_id, tool_name, raw_arguments, arguments_json,
      turn_sequence, status, result_json, result_sha256, started_at, finished_at
    ) VALUES ('legacy-result', 'turn-legacy', 'read_file', '{}', '{}', 1,
      'completed', ?, ?, '2026-08-25T00:00:01.000Z',
      '2026-08-25T00:00:02.000Z')`).run(resultJson, resultSha256);
    await sessionService.attachToolResult({
      ...scope,
      mutationCallId: "legacy-result-attach",
      toolCallId: "legacy-result",
    });
    await sessionService.recordCheckpoint({
      ...scope,
      mutationCallId: "legacy-result-checkpoint",
      actionUpdates: [{ actionKey: "publish", status: "done" }],
      publicSummary: "The legacy result is ready.",
      nextStep: "Publish the canonical records.",
    });
    await sessionService.recordReview({
      ...scope,
      mutationCallId: "legacy-result-review",
      subject: "result",
      verdict: "accept",
      summary: "The legacy result is accepted.",
      corrections: [],
    });
    await sessionService.recordDisposition({
      ...scope,
      mutationCallId: "legacy-open-disposition",
      workId: source.workId,
      disposition: "open",
      summary: "Canonical convergence remains to be observed.",
      remainingActions: ["Observe canonical convergence"],
    });
    expect(count(db, "btcc_guided_work_plan_revisions")).toBe(1);
    expect(count(db, "btcc_guided_work_checkpoint_revisions")).toBeGreaterThan(2);

    const resultRuntime = new SqliteProjectWorkResultRuntime(db);
    const runtime = testProjection(db, resultRuntime);
    const legacyRuntime = new SqliteProjectWorkLegacyRuntime(db);
    const stableSnapshot = (await legacyRuntime.captureStableSnapshot({
      scope,
      resolvedScope: {
        appProjectId: "app-project",
        ledgerProjectId: "ledger-project",
        ledgerRoot,
      },
    }))!;
    const stableSourceSha256 = stableSnapshot.sourceSha256;
    const adapterInput = {
      butlerData,
      scope: {
        appProjectId: "app-project",
        ledgerProjectId: "ledger-project",
        ledgerRoot,
      },
      runtimeProjection: runtime,
      resultRuntime,
      legacyRuntime,
    };
    const ledgerBeforeFailure = readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8");
    const invalidService = createDurableWorkService(createProjectWorkStore(adapterInput));
    insertPreparedEffect(
      db,
      source.workId,
      source.currentPlan!.planRevisionId,
      "effect-with-disposition",
    );
    await expect(invalidService.importOpenLegacyWork(scope)).rejects.toThrow();
    expect(readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8"))
      .toBe(ledgerBeforeFailure);
    db.query("DELETE FROM btcc_guided_effects WHERE effect_id = ?")
      .run("effect-with-disposition");
    expect(() => resultRuntime.observeCanonicalWorks({
      ledgerProjectId: "ledger-project",
      canonicalHeadSha256: "b".repeat(64),
      sessionHeadWorkId: stableSnapshot.work.workId,
      works: [{
        work: stableSnapshot.work,
        bindings: stableSnapshot.bindings,
      }],
    })).toThrow("project_work_runtime_ownership_conflict");
    expect(readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8"))
      .toBe(ledgerBeforeFailure);

    db.query(`UPDATE btcc_guided_turn_work_bindings SET session_id = 'wrong-session'
      WHERE work_id = ?`).run(source.workId);
    await expect(invalidService.importOpenLegacyWork(scope)).rejects.toThrow();
    expect(readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8"))
      .toBe(ledgerBeforeFailure);
    db.query(`UPDATE btcc_guided_turn_work_bindings SET session_id = 'session-legacy'
      WHERE work_id = ?`).run(source.workId);

    db.query(`UPDATE btcc_guided_turn_work_bindings SET is_current = 0
      WHERE work_id = ?`).run(source.workId);
    await expect(invalidService.importOpenLegacyWork(scope)).rejects.toThrow();
    expect(readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8"))
      .toBe(ledgerBeforeFailure);
    db.query(`UPDATE btcc_guided_turn_work_bindings SET is_current = 1
      WHERE work_id = ?`).run(source.workId);

    db.query(`UPDATE btcc_guided_works SET origin_message_id = 'wrong-message'
      WHERE work_id = ?`).run(source.workId);
    await expect(invalidService.importOpenLegacyWork(scope)).rejects.toThrow();
    expect(readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8"))
      .toBe(ledgerBeforeFailure);
    db.query(`UPDATE btcc_guided_works SET origin_message_id = 'message-legacy'
      WHERE work_id = ?`).run(source.workId);

    db.query(`UPDATE btcc_guided_work_checkpoint_revisions
      SET origin_turn_id = 'missing-turn' WHERE work_id = ? AND revision = 1`)
      .run(source.workId);
    await expect(invalidService.importOpenLegacyWork(scope)).rejects.toThrow();
    expect(readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8"))
      .toBe(ledgerBeforeFailure);
    db.query(`UPDATE btcc_guided_work_checkpoint_revisions
      SET origin_turn_id = 'turn-legacy' WHERE work_id = ? AND revision = 1`)
      .run(source.workId);

    db.query(`UPDATE btcc_guided_work_legacy_imports
      SET source_revision = 'bad' WHERE import_id = ?`).run(r2ImportId);
    await expect(invalidService.importOpenLegacyWork(scope)).rejects.toThrow();
    expect(readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8"))
      .toBe(ledgerBeforeFailure);
    db.query(`UPDATE btcc_guided_work_legacy_imports
      SET source_revision = ? WHERE import_id = ?`).run("a".repeat(64), r2ImportId);

    db.query("UPDATE btcc_guided_tool_calls SET result_sha256 = NULL WHERE call_id = 'legacy-result'")
      .run();
    await expect(invalidService.importOpenLegacyWork(scope)).rejects.toThrow();
    expect(readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8"))
      .toBe(ledgerBeforeFailure);
    expect(count(db, "btcc_guided_work_plan_revisions")).toBe(1);
    db.query("UPDATE btcc_guided_tool_calls SET result_sha256 = ? WHERE call_id = 'legacy-result'")
      .run(resultSha256);

    const crashAfterPromotion = createDurableWorkService(createProjectWorkStore({
      ...adapterInput,
      legacyRuntime: {
        readImportObservation: legacyRuntime.readImportObservation.bind(legacyRuntime),
        captureStableSnapshot: legacyRuntime.captureStableSnapshot.bind(legacyRuntime),
        revalidateBeforeObservation:
          legacyRuntime.revalidateBeforeObservation.bind(legacyRuntime),
        observeImported() { throw new Error("simulated_cleanup_crash"); },
      },
    }));
    await expect(crashAfterPromotion.importOpenLegacyWork(scope)).rejects.toThrow();
    expect(count(db, "btcc_guided_work_plan_revisions")).toBe(1);

    const payloadRaceService = createDurableWorkService(createProjectWorkStore({
      ...adapterInput,
      legacyRuntime: {
        readImportObservation: legacyRuntime.readImportObservation.bind(legacyRuntime),
        captureStableSnapshot: legacyRuntime.captureStableSnapshot.bind(legacyRuntime),
        revalidateBeforeObservation:
          legacyRuntime.revalidateBeforeObservation.bind(legacyRuntime),
        observeImported(input) {
          db.query(`UPDATE btcc_guided_tool_calls SET result_json = ?
            WHERE call_id = 'legacy-result'`).run('{"tampered":true}');
          legacyRuntime.observeImported(input);
        },
      },
    }));
    await expect(payloadRaceService.importOpenLegacyWork(scope)).rejects.toThrow();
    expect(count(db, "btcc_guided_work_plan_revisions")).toBe(1);
    db.query(`UPDATE btcc_guided_tool_calls SET result_json = ?
      WHERE call_id = 'legacy-result'`).run(resultJson);

    db.query("UPDATE btcc_guided_tool_calls SET result_sha256 = NULL WHERE call_id = 'legacy-result'")
      .run();
    const service = createDurableWorkService(createProjectWorkStore(adapterInput));
    await expect(service.importOpenLegacyWork(scope)).rejects.toThrow();
    expect(count(db, "btcc_guided_work_plan_revisions")).toBe(1);
    db.query("UPDATE btcc_guided_tool_calls SET result_sha256 = ? WHERE call_id = 'legacy-result'")
      .run(resultSha256);

    db.query(`UPDATE btcc_guided_work_legacy_imports
      SET source_authority = 'session_sqlite' WHERE import_id = ?`).run(r2ImportId);
    await expect(service.importOpenLegacyWork(scope)).rejects.toThrow();
    expect(count(db, "btcc_guided_work_plan_revisions")).toBe(1);
    db.query(`UPDATE btcc_guided_work_legacy_imports
      SET source_authority = 'project_ledger' WHERE import_id = ?`).run(r2ImportId);
    expect((await legacyRuntime.captureStableSnapshot({
      scope,
      resolvedScope: adapterInput.scope,
    }))?.sourceSha256).toBe(stableSourceSha256);

    const imported = await service.importOpenLegacyWork(scope);
    expect(imported).toMatchObject({
      imported: false,
      sourceProgramId: "program-r2",
      work: {
        workId: source.workId,
        objective: source.objective,
        latestPlanReview: { verdict: "accept" },
        latestResultReview: { verdict: "accept" },
        latestDisposition: { disposition: "open" },
        resultRefs: [{ toolCallId: "legacy-result", resultSha256 }],
      },
    });
    expect(count(db, "btcc_guided_work_plan_revisions")).toBe(0);
    expect(count(db, "btcc_guided_work_checkpoint_revisions")).toBe(0);
    expect(count(db, "btcc_guided_work_legacy_imports")).toBe(1);

    insertTurn(db, "turn-after-import", "message-after-import");
    const laterScope = {
      ...scope,
      turnId: "turn-after-import",
    };
    const later = await service.continueWork({
      ...laterScope,
      mutationCallId: "later-project-mutation",
      workId: source.workId,
    });
    expect(later.workId).toBe(source.workId);
    const ledgerBeforeReplay = readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8");
    const sqliteBeforeReplay = projectionRows(db);
    expect(await service.importOpenLegacyWork(laterScope)).toMatchObject({
      imported: false,
      work: { workId: source.workId },
    });
    expect(readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8"))
      .toBe(ledgerBeforeReplay);
    expect(projectionRows(db)).toEqual(sqliteBeforeReplay);
  } finally {
    db.close();
  }
});

test("publishes a complete current-R3 snapshot once with stable source identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-project-current-r3-convergence-"));
  roots.push(root);
  const butlerData = join(root, "data");
  const requested = join(butlerData, "project-ledger", "projects", "ledger-project");
  mkdirSync(requested, { recursive: true });
  const ledgerRoot = realpathSync(requested);
  writeFileSync(join(ledgerRoot, "project.json"), `${JSON.stringify({
    schema: "project-ledger.project.v1",
    id: "ledger-project",
    name: "Current R3 convergence",
    status: "active",
  }, null, 2)}\n`);
  writeFileSync(join(ledgerRoot, "ledger.jsonl"), "");
  const core = await loadProjectLedgerCore();
  core.writeIndex(ledgerRoot);

  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    insertTurn(db);
    const turnScope = {
      turnId: "turn-legacy",
      sessionId: "session-legacy",
      projectRef: "app-project",
    };
    const sqlite = new SqliteGuidedWorkStore(
      db,
      createPrincipalAuthority(new SqlitePrincipalAuthorityRepository(db)),
    );
    const sqliteService = createDurableWorkService(sqlite);
    const started = await sqliteService.startWork({
      ...turnScope,
      mutationCallId: "current-r3-start",
      objective: "Publish current R3 Work",
    });
    const planned = await sqliteService.replacePlan({
      ...turnScope,
      mutationCallId: "current-r3-plan",
      objective: started.objective,
      actions: [{ actionKey: "publish", description: "Publish", dependencyKeys: [] }],
      checks: ["stable identity"],
    });
    insertPreparedEffect(
      db,
      started.workId,
      planned.currentPlan!.planRevisionId,
      "effect-current-r3",
    );
    const resultRuntime = new SqliteProjectWorkResultRuntime(db);
    const legacyRuntime = new SqliteProjectWorkLegacyRuntime(db);
    const service = createDurableWorkService(createProjectWorkStore({
      butlerData,
      scope: {
        appProjectId: "app-project",
        ledgerProjectId: "ledger-project",
        ledgerRoot,
      },
      runtimeProjection: testProjection(db, resultRuntime),
      resultRuntime,
      legacyRuntime,
    }));
    const currentProgramId = `current-r3:${started.workId}`;
    const currentCollisionImportId = "current-r3-collision-import";
    db.query(`INSERT INTO btcc_guided_work_legacy_imports (
      import_id, legacy_program_id, session_id, scope_kind, scope_ref,
      source_authority, source_revision, work_id, imported_at
    ) VALUES (?, ?, 'session-legacy', 'project', 'app-project',
      'project_ledger', ?, 'other-work', '2026-08-25T00:00:00.000Z')`)
      .run(currentCollisionImportId, currentProgramId, "c".repeat(64));
    const ledgerBeforeCollision = readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8");
    const sqliteBeforeCollision = projectionRows(db);
    await expect(service.importOpenLegacyWork(turnScope)).rejects.toThrow();
    expect(readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8"))
      .toBe(ledgerBeforeCollision);
    expect(projectionRows(db)).toEqual(sqliteBeforeCollision);
    db.query("DELETE FROM btcc_guided_work_legacy_imports WHERE import_id = ?")
      .run(currentCollisionImportId);
    const imported = await service.importOpenLegacyWork(turnScope);
    expect(imported).toMatchObject({
      imported: true,
      sourceProgramId: `current-r3:${started.workId}`,
      work: { workId: started.workId },
    });
    expect(count(db, "btcc_guided_work_plan_revisions")).toBe(0);
    const beforeReplay = projectionRows(db);
    expect(await service.importOpenLegacyWork(turnScope)).toMatchObject({
      imported: false,
      sourceProgramId: `current-r3:${started.workId}`,
      work: { workId: started.workId },
    });
    expect(projectionRows(db)).toEqual(beforeReplay);
  } finally {
    db.close();
  }
});

test("publishes a pure raw R2 Project snapshot without intermediate semantic R3 authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-project-raw-r2-convergence-"));
  roots.push(root);
  const butlerData = join(root, "data");
  const requested = join(butlerData, "project-ledger", "projects", "ledger-project");
  mkdirSync(requested, { recursive: true });
  const ledgerRoot = realpathSync(requested);
  writeFileSync(join(ledgerRoot, "project.json"), `${JSON.stringify({
    schema: "project-ledger.project.v1",
    id: "ledger-project",
    name: "Raw R2 convergence",
    status: "active",
  }, null, 2)}\n`);
  writeFileSync(join(ledgerRoot, "ledger.jsonl"), "");
  const core = await loadProjectLedgerCore();
  core.writeIndex(ledgerRoot);
  const program = await publishReviewedProgram(core, ledgerRoot);

  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    seedProjectLocator(
      db,
      program.programId,
      "session-raw-r2",
      `message-${program.programId}`,
    );
    db.query(`INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, managed_state_json, semantic_state, revision,
      execution_fence, route
    ) VALUES ('turn-r2-missing', 'session-raw-r2', 'inbox-turn-r2-missing',
      'trigger-turn-r2-missing', 'message-r2-missing',
      'historical missing R2 Program', 'snapshot', '{}', '{}',
      '{"programId":"program-r2-missing"}', 'admitted', 1, 0, 'managed')`)
      .run();
    db.query(`INSERT INTO btcc_project_program_projections (
      program_id, project_ref, ledger_id, manifest_revision
    ) VALUES ('program-r2-missing', 'stale-local-project-ref',
      'stale-local-ledger', 999)`).run();
    expect(count(db, "btcc_guided_works")).toBe(0);
    const scope = {
      turnId: `turn-r2-${program.programId}`,
      sessionId: "session-raw-r2",
      projectRef: "project:ledger-project",
    };
    const resultRuntime = new SqliteProjectWorkResultRuntime(db);
    const rawSource = createProjectLedgerLegacyWorkSource({ butlerData });
    const legacyRuntime = new SqliteProjectWorkLegacyRuntime(db, rawSource);
    const service = createDurableWorkService(createProjectWorkStore({
      butlerData,
      scope: {
        appProjectId: "project:ledger-project",
        ledgerProjectId: "ledger-project",
        ledgerRoot,
      },
      runtimeProjection: testProjection(db, resultRuntime),
      resultRuntime,
      legacyRuntime,
    }));
    const rawImportId = guidedWorkRecordId(
      "legacy-import",
      `${program.programId}\0session-raw-r2\0project:ledger-project`,
    );
    const rawCollisionImportId = "raw-r2-collision-import";
    db.query(`INSERT INTO btcc_guided_work_legacy_imports (
      import_id, legacy_program_id, session_id, scope_kind, scope_ref,
      source_authority, source_revision, work_id, imported_at
    ) VALUES (?, ?, 'session-raw-r2', 'project', 'project:ledger-project',
      'project_ledger', ?, 'wrong-work', '2026-08-25T00:00:00.000Z')`)
      .run(rawCollisionImportId, program.programId, "d".repeat(64));
    const beforeCollision = readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8");
    const sqliteBeforeCollision = projectionRows(db);
    await expect(service.importOpenLegacyWork(scope)).rejects.toThrow();
    expect(readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8"))
      .toBe(beforeCollision);
    expect(projectionRows(db)).toEqual(sqliteBeforeCollision);
    db.query("DELETE FROM btcc_guided_work_legacy_imports WHERE import_id = ?")
      .run(rawCollisionImportId);
    const adapterInput = {
      butlerData,
      scope: {
        appProjectId: "project:ledger-project",
        ledgerProjectId: "ledger-project",
        ledgerRoot,
      },
      runtimeProjection: testProjection(db, resultRuntime),
      resultRuntime,
      legacyRuntime,
    };
    let sourceLoads = 0;
    const mutatingSource: LegacyProjectWorkSource = {
      async loadOpenWork(input) {
        const snapshot = await rawSource.loadOpenWork(input);
        sourceLoads += 1;
        if (sourceLoads !== 2 || !snapshot) return snapshot;
        const goalContract = snapshot.goalContract;
        if (
          !goalContract || typeof goalContract !== "object" ||
          Array.isArray(goalContract)
        ) throw new Error("test_goal_contract_missing");
        return {
          ...snapshot,
          goalContract: {
            ...goalContract,
            request: "The R2 source changed after Project publication.",
          },
        };
      },
    };
    const mutatingRuntime = new SqliteProjectWorkLegacyRuntime(db, mutatingSource);
    const mutatingService = createDurableWorkService(createProjectWorkStore({
      ...adapterInput,
      legacyRuntime: mutatingRuntime,
    }));
    const ledgerBeforeBoundary = readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8");
    await expect(mutatingService.importOpenLegacyWork(scope)).rejects.toThrow();
    expect(readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8"))
      .not.toBe(ledgerBeforeBoundary);
    expect(count(db, "btcc_guided_work_legacy_imports")).toBe(0);
    expect(count(db, "btcc_guided_work_plan_revisions")).toBe(0);
    expect(count(db, "btcc_guided_work_checkpoint_revisions")).toBe(0);
    const imported = await mutatingService.importOpenLegacyWork(scope);
    expect(imported).toMatchObject({
      imported: false,
      sourceProgramId: program.programId,
      work: {
        objective: "Produce the fixture result",
        currentPlan: { actions: [{ actionKey: "produce-result" }] },
        latestCheckpoint: { stage: "execution" },
      },
    });
    expect(count(db, "btcc_guided_work_plan_revisions")).toBe(0);
    expect(count(db, "btcc_guided_work_checkpoint_revisions")).toBe(0);
    expect(count(db, "btcc_guided_work_legacy_imports")).toBe(1);
    const replayState = projectionRows(db);
    expect(await mutatingService.importOpenLegacyWork(scope)).toMatchObject({
      imported: false,
      sourceProgramId: program.programId,
      work: { workId: imported?.work.workId },
    });
    expect(projectionRows(db)).toEqual(replayState);

    db.query(`UPDATE btcc_guided_work_legacy_imports
      SET import_id = 'corrupted-import-id' WHERE import_id = ?`).run(rawImportId);
    const ledgerBeforeCorruptRepeat = readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8");
    const sqliteBeforeCorruptRepeat = projectionRows(db);
    await expect(mutatingService.importOpenLegacyWork(scope)).rejects.toThrow();
    expect(readFileSync(join(ledgerRoot, "ledger.jsonl"), "utf8"))
      .toBe(ledgerBeforeCorruptRepeat);
    expect(projectionRows(db)).toEqual(sqliteBeforeCorruptRepeat);
    db.query(`UPDATE btcc_guided_work_legacy_imports
      SET import_id = ? WHERE import_id = 'corrupted-import-id'`).run(rawImportId);
  } finally {
    db.close();
  }
});

function testProjection(
  db: Database,
  concrete: SqliteProjectWorkResultRuntime,
): ProjectWorkRuntimeProjection {
  return {
    locateCanonicalWorks: concrete.locateCanonicalWorks.bind(concrete),
    loadOriginalRequest(scope) {
      const row = db.query<{ original_message_id: string; original_message: string }, [string]>(
        "SELECT original_message_id, original_message FROM btcc_turns WHERE turn_id = ?",
      ).get(scope.turnId)!;
      return Promise.resolve({
        turnId: scope.turnId,
        messageId: row.original_message_id,
        content: row.original_message,
      });
    },
    loadResultFacts() { return Promise.resolve([]); },
    operationRecordedAt(_identity: ProjectWorkOperationIdentity) {
      return Promise.resolve("2026-08-25T01:00:00.000Z");
    },
    prepareDisposition(input: {
      command: RecordWorkDispositionCommand;
      current: DurableWorkView;
    }) {
      return Promise.resolve({
        mode: "apply" as const,
        actionProgress: input.command.actionUpdates?.length
          ? applyWorkActionUpdates(input.current, input.command.actionUpdates)
          : input.current.actionProgress,
        evidenceSnapshot: input.command.evidenceRefs ?? [],
      });
    },
    captureWorkMaterial(input: { candidate: DurableWorkView }) {
      const materialFingerprint = dispositionMaterialFingerprint(input.candidate);
      return Promise.resolve({
        materialFingerprint,
        materialSnapshot: captureMaterialSnapshot(
          input.candidate,
          {
            effectWatermark: input.candidate.effectWatermark ?? null,
            effectBlockers: [],
          },
          materialFingerprint,
        ),
      });
    },
    observeCanonicalWorks: concrete.observeCanonicalWorks.bind(concrete),
  };
}

function insertTurn(
  db: Database,
  turnId = "turn-legacy",
  messageId = "message-legacy",
) {
  db.query(`INSERT INTO btcc_turns (
    turn_id, session_id, inbox_id, trigger_key, original_message_id,
    original_message, admission_snapshot_ref, model_selection_json,
    context_json, semantic_state, revision, execution_fence
  ) VALUES (?, 'session-legacy', ?, ?, ?, 'continue', 'snapshot', '{}', '{}',
    'admitted', 1, 0)`)
    .run(turnId, `inbox-${turnId}`, `trigger-${turnId}`, messageId);
}

function count(db: Database, table: string) {
  return db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
    .get()!.count;
}

function projectionRows(db: Database) {
  return {
    works: db.query("SELECT * FROM btcc_guided_works ORDER BY work_id").all(),
    heads: db.query("SELECT * FROM btcc_guided_work_session_heads ORDER BY session_id").all(),
    bindings: db.query("SELECT * FROM btcc_guided_turn_work_bindings ORDER BY binding_revision_id").all(),
    imports: db.query("SELECT * FROM btcc_guided_work_legacy_imports ORDER BY import_id").all(),
  };
}

function insertPreparedEffect(
  db: Database,
  workId: string,
  planRevisionId: string,
  effectId: string,
) {
  db.query(`INSERT INTO btcc_guided_effects (
    effect_id, receipt_id, idempotency_key, identity_sha256, request_sha256,
    input_sha256, target_sha256, work_id, plan_revision_id, action_key,
    capability, sanitized_target, status, journal_revision, dispatch_attempts,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'publish', 'write_file', 'target',
    'prepared', 1, 0, '2026-08-25T00:00:00.000Z',
    '2026-08-25T00:00:00.000Z')`).run(
    effectId,
    `receipt-${effectId}`,
    `idem-${effectId}`,
    sha(`identity-${effectId}`),
    sha(`request-${effectId}`),
    sha(`input-${effectId}`),
    sha(`target-${effectId}`),
    workId,
    planRevisionId,
  );
}

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
