import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { SqliteWorkLedgerStorage } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/work-ledger/index.ts";
import { discoverContinuationCandidates } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/continuation-candidate-discovery.ts";
import { openingAnswerCodec } from "../../packages/butler-agent/src/agent/btcc/conception/opening/opening-answer-codec.ts";
import { decideTransition } from "../../packages/butler-agent/src/agent/btcc/turn/state-machine/decide-transition.ts";
import type { TurnRecord } from "../../packages/butler-agent/src/agent/btcc/turn/contracts.ts";
import { bindAndContinue, freshContinuationCommand, seedManagedProgramForStop, seedStoppedProgram, taskStatuses } from "./support/btcc-stopped-work-fixture.ts";
import { canonicalMutationId } from "./support/btcc-project-ledger-fixture.ts";
import { SqliteTurnStateRepository } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/turn-state-repository.ts";
import { SqliteRuntimeOwnerRegistry } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/runtime-owner/index.ts";
import type { ProjectWorkLedgerPublicationAdapter } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { ledgerManifestContentHash } from "../../packages/butler-agent/src/agent/btcc/gateway-api.ts";

test("Stop reloads a typed frontier and a fresh Turn continues only unfinished Tasks", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-stopped-program-"));
  const dbPath = join(root, "btcc.sqlite");
  try {
    let db = new Database(dbPath);
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    await seedStoppedProgram(db);
    expect(taskStatuses(db)).toEqual(["accepted", "accepted", "selected", "planned"]);
    expect(terminalWakeRows(db)).toEqual([
      { turn_id: "turn-user-stopped", semantic_state: "cancelled" },
    ]);
    db.close();

    db = new Database(dbPath);
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const storage = new SqliteWorkLedgerStorage(db);
    const candidates = await discoverContinuationCandidates(db, freshContinuationCommand());
    expect(candidates).toHaveLength(1);
    const continuation = candidates[0]!;
    expect(continuation.continuationKind).toBe("user_stopped");
    expect(continuation.sourceTurnId).toBe("turn-user-stopped");
    expect(continuation.context?.frontier.completedTasks?.map((item) =>
      item.task.taskLogicalId)).toEqual(["task-a", "task-b"]);
    expect(continuation.context?.frontier.interruptedTask?.task.taskLogicalId)
      .toBe("task-c");
    expect(continuation.context?.frontier.pendingTasks?.map((item) =>
      item.task.taskLogicalId)).toEqual(["task-d"]);

    bindAndContinue(storage, continuation);

    expect(taskStatuses(db)).toEqual(["accepted", "accepted", "planned", "planned"]);
    expect(await discoverContinuationCandidates(db, freshContinuationCommand())).toEqual([]);
    expect(stoppedCandidateStatus(db)).toBe("bound");
    expect(oldTurnState(db)).toBe("cancelled");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancel_work consumes only the exact candidate and preserves accepted Tasks", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const storage = await seedStoppedProgram(db);
  const candidates = await discoverContinuationCandidates(db, freshContinuationCommand());
  const candidate = candidates[0]!;
  const envelope = {
    binding: { turnId: "turn-cancel-work" },
    context: {
      originalMessageId: "message-cancel-work",
      continuationCandidates: candidates,
    },
  } as never;
  expect(() => openingAnswerCodec(candidates.map(({ candidateId }) => candidateId)).decode({
    kind: "cancel_work",
    continuationCandidateId: "unrelated-candidate",
    reason: "Cancel it",
  }, envelope)).toThrow("unavailable Program");
  const product = openingAnswerCodec(
    candidates.map(({ candidateId }) => candidateId),
  ).decode({
    kind: "cancel_work",
    continuationCandidateId: candidate.candidateId,
    reason: "Abandon this exact Program",
  }, envelope);
  if (product.kind !== "opening_work_cancellation") {
    throw new Error("Opening cancellation product expected");
  }
  const turn = {
    turnId: "turn-cancel-work",
    sessionId: "session-fixture",
    revision: 0,
    semanticState: "conception_opening",
    continuationCandidates: candidates,
  } as TurnRecord;
  const decision = decideTransition(turn, { kind: "WorkCancellationAccepted", product });
  if (decision.kind !== "accepted" ||
    decision.transition.kind !== "accept_work_cancellation") {
    throw new Error("Work cancellation transition expected");
  }
  const forged = structuredClone(decision.transition.ledgerCommit);
  if (forged.mutation.kind !== "cancel_program") throw new Error("Cancellation expected");
  forged.mutation.continuationCandidateId = "another-candidate";
  const current = storage.loadProgram("program-session");
  if (!current) throw new Error("Program expected");
  forged.mutationId = canonicalMutationId(forged, current);
  expect(() => storage.commit(forged)).toThrow("cancellation candidate changed");
  const afterForgery = storage.loadProgram("program-session");
  expect(afterForgery?.planningState).toBe("reviewed");
  if (!afterForgery || afterForgery.planningState !== "reviewed") {
    throw new Error("Reviewed Program expected after rollback");
  }
  expect(afterForgery.frontier).toBe("implementation_open");
  expect(stoppedCandidateStatus(db)).toBe("eligible");

  storage.commit(decision.transition.ledgerCommit);

  expect(storage.loadProgram("program-session")).toMatchObject({
    frontier: "cancelled",
    tasks: [
      { status: "accepted" },
      { status: "accepted" },
      { status: "cancelled" },
      { status: "cancelled" },
    ],
    cancellation: {
      kind: "cancel_work",
      reason: "Abandon this exact Program",
    },
  });
  expect(await discoverContinuationCandidates(db, freshContinuationCommand())).toEqual([]);
  expect(stoppedCandidateStatus(db)).toBe("cancelled");
  expect(oldTurnState(db)).toBe("cancelled");
  db.close();
});

test("project Stop retries promotion racing hydration and preserves the promoted Program", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const projectRef = "project:loader-owned";
  const { program } = seedManagedProgramForStop(db, projectRef);
  const promotedProgram = { ...program, manifestRevision: program.manifestRevision + 1 };
  db.query(`
    INSERT INTO btcc_project_program_projections (
      program_id, project_ref, ledger_id, manifest_revision
    ) VALUES (?, ?, ?, ?)
  `).run(program.programId, projectRef, program.ledgerId, program.manifestRevision);
  let promoted = false;
  const loadedRevisions: number[] = [];
  const publications = {
    loadProgram: async (projectRoot: string, programId: string) => {
      expect(projectRoot).toBe("/canonical/project");
      expect(programId).toBe(program.programId);
      const loaded = promoted ? promotedProgram : program;
      loadedRevisions.push(loaded.manifestRevision);
      if (loadedRevisions.length === 1) {
        installPendingPromotion(db, promotedProgram.manifestRevision);
      }
      return loaded;
    },
    promoteAndObserve: async () => { promoted = true; },
    listDeferredPrograms: async () => [],
  } as unknown as ProjectWorkLedgerPublicationAdapter;
  const owner = new SqliteRuntimeOwnerRegistry(db, {
    ownerId: "project-stop-owner",
    hostId: "test-host",
    processId: 2,
    processStartedAtMs: 2,
  }, { isAlive: () => true });
  const turns = new SqliteTurnStateRepository(db, owner, {
    publications,
    resolveProjectRoot: (ref) => {
      expect(ref).toBe(projectRef);
      return "/canonical/project";
    },
  });

  expect(await turns.stopTurn("turn-user-stopped")).toEqual({
    kind: "cancelled",
    turnId: "turn-user-stopped",
  });
  expect(loadedRevisions).toEqual([
    program.manifestRevision,
    promotedProgram.manifestRevision,
  ]);
  expect(JSON.parse(managedStateJson(db))).not.toHaveProperty("program");
  const candidateRow = db.query<{
    scope_kind: string;
    scope_id: string;
    program_id: string;
    expected_manifest_revision: number;
    base_manifest_hash: string;
  }, []>(`
    SELECT scope_kind, scope_id, program_id, expected_manifest_revision, base_manifest_hash
    FROM btcc_stopped_program_continuations
  `).get();
  expect(candidateRow).toEqual({
    scope_kind: "project",
    scope_id: projectRef,
    program_id: program.programId,
    expected_manifest_revision: promotedProgram.manifestRevision,
    base_manifest_hash: ledgerManifestContentHash(promotedProgram, {
      ledgerId: program.ledgerId,
      programId: program.programId,
    }),
  });
  const fresh = freshContinuationCommand();
  const candidates = await discoverContinuationCandidates(db, {
    ...fresh,
    context: { ...fresh.context, projectRef },
  }, {
    publications,
    resolveProjectRoot: () => "/canonical/project",
  });
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    expectedManifestRevision: promotedProgram.manifestRevision,
    baseManifestHash: candidateRow?.base_manifest_hash,
  });
  expect(loadedRevisions).toEqual([
    program.manifestRevision,
    promotedProgram.manifestRevision,
    promotedProgram.manifestRevision,
  ]);
  owner.close();
  db.close();
});

function stoppedCandidateStatus(db: Database): string | undefined {
  return db.query<{ status: string }, []>(
    "SELECT status FROM btcc_stopped_program_continuations",
  ).get()?.status;
}
function oldTurnState(db: Database): string | undefined {
  return db.query<{ semantic_state: string }, [string]>(
    "SELECT semantic_state FROM btcc_turns WHERE turn_id = ?",
  ).get("turn-user-stopped")?.semantic_state;
}

function terminalWakeRows(db: Database) {
  return db.query<{
    turn_id: string;
    semantic_state: string;
  }, []>(`
    SELECT turn_id, semantic_state FROM btcc_terminal_settlement_wakes
    ORDER BY turn_id
  `).all();
}

function managedStateJson(db: Database): string {
  return db.query<{ managed_state_json: string }, []>(`
    SELECT managed_state_json FROM btcc_turns
    WHERE turn_id = 'turn-user-stopped'
  `).get()!.managed_state_json;
}

function installPendingPromotion(db: Database, promotedRevision: number): void {
  db.query("UPDATE btcc_turns SET revision = 8 WHERE turn_id = ?")
    .run("turn-user-stopped");
  db.query(`
    UPDATE btcc_project_program_projections SET manifest_revision = ?
    WHERE program_id = 'program-session'
  `).run(promotedRevision);
  db.query(`
    INSERT INTO btcc_ledger_promotion_outbox (
      outbox_id, turn_id, committed_turn_revision, mutation_id,
      ledger_id, program_id, publication_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    "promotion-racing-stop", "turn-user-stopped", 8, "mutation-racing-stop",
    "session:session-fixture", "program-session",
    JSON.stringify({
      ledgerId: "session:session-fixture",
      programId: "program-session",
      manifestSha256: "promoted-manifest",
      corePublication: { publicationId: "publication-racing-stop" },
    }),
  );
}
