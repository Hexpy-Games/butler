import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type {
  PreparedProjectLedgerPublication,
  ProjectWorkLedgerPublicationAdapter,
} from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { ProjectLedgerPromotionWriter } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/project-ledger-promotion-writer.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { SqliteTurnAdmissionRepository } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/turn-admission-repository.ts";
import { SqliteTurnStateRepository } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/turn-state-repository.ts";
import { SqliteRuntimeOwnerRegistry } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/runtime-owner/index.ts";
import { LocalProcessLiveness } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/runtime-owner/index.ts";

describe("BTCC Project Ledger activation gate", () => {
  test("binds the exact publication atomically and observes it before successor claims", async () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const publication = preparedPublication();
    let promotions = 0;
    const publications: ProjectWorkLedgerPublicationAdapter = {
      async observeCanonicalHead() { return publication.canonicalBase; },
      async prepareCommit() { throw new Error("unused"); },
      async loadProgram() { return null; },
      async listDeferredPrograms() { return []; },
      observePublicationState() { return "released"; },
      observeMutationClaimState() { return "released"; },
      async reconcileOrphanedPublications() {},
      async abort() {},
      async promoteAndObserve(observed) {
        expect(observed).toEqual(publication);
        promotions += 1;
      },
    };
    const projectLedger = {
      publications,
      resolveProjectRoot: () => "/canonical/project",
    };
    const owner = testOwner(db);
    const turns = new SqliteTurnStateRepository(db, owner, projectLedger);
    const admission = new SqliteTurnAdmissionRepository(db, turns, owner, projectLedger);
    const command = runCommand();
    const inbox = await admission.recordInbound({ command, admissionInputHash: "input-sha" });
    const construction = await admission.acquireAdmissionConstructionClaim(inbox);
    const turn = await admission.constructTurn(inbox, construction);
    const outbox = new ProjectLedgerPromotionWriter(db);

    expect(() => db.transaction(() => {
      outbox.preparePromotionOutbox({
        turnId: turn.turnId,
        nextRevision: 3,
        commit: ledgerCommit(),
        publication,
      });
      throw new Error("turn CAS failed");
    })()).toThrow("turn CAS failed");
    expect(outbox.loadPending(turn.turnId)).toBeNull();

    db.transaction(() => outbox.preparePromotionOutbox({
      turnId: turn.turnId,
      nextRevision: 3,
      commit: ledgerCommit(),
      publication,
    }))();
    expect(outbox.loadPending(turn.turnId)).toEqual({
      outboxId: expect.any(String),
      publication,
      status: "pending",
    });
    await expect(turns.acquireStateExecutionClaim(turn))
      .rejects.toThrow("unobserved Project Ledger promotion");

    expect(await turns.activateCommittedSuccessor(turn.turnId)).toEqual(turn);
    expect(await turns.activateCommittedSuccessor(turn.turnId)).toEqual(turn);
    expect(promotions).toBe(1);
    expect(outbox.loadPending(turn.turnId)?.status).toBe("observed");
    expect((await turns.acquireStateExecutionClaim(turn)).turnId).toBe(turn.turnId);
    db.close();
  });

  test("startup drains committed promotions before claims become available", async () => {
    const fixture = await activationFixture();
    fixture.outbox.preparePromotionOutbox({
      turnId: fixture.turn.turnId,
      nextRevision: 3,
      commit: ledgerCommit(),
      publication: fixture.publication,
    });

    await fixture.turns.recoverPendingProjectLedgerPromotions();

    expect(fixture.promotions()).toBe(1);
    expect(fixture.outbox.loadPending(fixture.turn.turnId)?.status).toBe("observed");
    expect((await fixture.turns.acquireStateExecutionClaim(fixture.turn)).turnId)
      .toBe(fixture.turn.turnId);
    fixture.db.close();
  });

  test("Stop completes a committed promotion and fences its successor", async () => {
    const fixture = await activationFixture();
    fixture.outbox.preparePromotionOutbox({
      turnId: fixture.turn.turnId,
      nextRevision: 3,
      commit: ledgerCommit(),
      publication: fixture.publication,
    });

    expect(await fixture.turns.stopTurn(fixture.turn.turnId)).toEqual({
      kind: "cancelled",
      turnId: fixture.turn.turnId,
    });

    expect(fixture.promotions()).toBe(1);
    expect(fixture.stateObservedAtPromotion()).toBe("cancelled");
    expect(fixture.outbox.loadPending(fixture.turn.turnId)?.status).toBe("observed");
    const cancelled = await fixture.turns.findTurn(fixture.turn.turnId);
    expect(cancelled?.semanticState).toBe("cancelled");
    await expect(fixture.turns.acquireStateExecutionClaim(cancelled!))
      .rejects.toThrow("no active checkpoint");
    fixture.db.close();
  });

  test("adopts dead runtime claims while preserving checkpoint revision and fence", async () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const firstOwner = new SqliteRuntimeOwnerRegistry(db, {
      ownerId: "owner-dead", hostId: "test-host", processId: 101, processStartedAtMs: 1,
    }, { isAlive: () => true });
    const firstTurns = new SqliteTurnStateRepository(db, firstOwner);
    const firstAdmission = new SqliteTurnAdmissionRepository(db, firstTurns, firstOwner);
    const projectCommand = runCommand();
    const { projectRef: _projectRef, ...sessionContext } = projectCommand.context;
    const command = { ...projectCommand, context: sessionContext };
    const inbox = await firstAdmission.recordInbound({ command, admissionInputHash: "input-sha" });
    const construction = await firstAdmission.acquireAdmissionConstructionClaim(inbox);
    const turn = await firstAdmission.constructTurn(inbox, construction);
    const firstClaim = await firstTurns.acquireStateExecutionClaim(turn);

    const nextOwner = new SqliteRuntimeOwnerRegistry(db, {
      ownerId: "owner-next", hostId: "test-host", processId: 202, processStartedAtMs: 2,
    }, { isAlive: (identity) => identity.ownerId !== "owner-dead" });
    const nextTurns = new SqliteTurnStateRepository(db, nextOwner);
    const adopted = await nextTurns.acquireStateExecutionClaim(turn);
    const row = db.query<{
      owner_id: string;
      checkpoint_revision: number;
      execution_fence: number;
    }, [string]>(`
      SELECT owner_id, checkpoint_revision, execution_fence
      FROM btcc_state_claims WHERE claim_id = ?
    `).get(firstClaim.claimId);

    expect(adopted.claimId).toBe(firstClaim.claimId);
    expect(row).toEqual({
      owner_id: "owner-next",
      checkpoint_revision: firstClaim.checkpointRevision,
      execution_fence: firstClaim.executionFence,
    });
    db.close();
  });

  test("treats a reused PID as a dead owner by comparing process start identity", () => {
    const reusedPid = 101;
    const liveness = new LocalProcessLiveness("test-host", (processId) => ({
      kind: "found",
      startedAtMs: processId === reusedPid ? 2_000 : 3_000,
    }));

    expect(liveness.isAlive({
      ownerId: "old-owner",
      hostId: "test-host",
      processId: reusedPid,
      processStartedAtMs: 1_000,
    })).toBe(false);
    expect(liveness.isAlive({
      ownerId: "current-owner",
      hostId: "test-host",
      processId: reusedPid,
      processStartedAtMs: 2_000,
    })).toBe(true);
  });

  test("reacquires a relinquished State claim in the same runtime", async () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const owner = testOwner(db);
    const turns = new SqliteTurnStateRepository(db, owner);
    const admission = new SqliteTurnAdmissionRepository(db, turns, owner);
    const projectCommand = runCommand();
    const { projectRef: _projectRef, ...sessionContext } = projectCommand.context;
    const command = { ...projectCommand, context: sessionContext };
    const inbox = await admission.recordInbound({ command, admissionInputHash: "input-sha" });
    const construction = await admission.acquireAdmissionConstructionClaim(inbox);
    const turn = await admission.constructTurn(inbox, construction);
    const first = await turns.acquireStateExecutionClaim(turn);

    db.query("UPDATE btcc_state_claims SET status = 'relinquished' WHERE claim_id = ?")
      .run(first.claimId);
    db.query("UPDATE btcc_checkpoints SET active_claim_id = NULL WHERE checkpoint_id = ?")
      .run(first.checkpointId);

    expect(await turns.acquireStateExecutionClaim(turn)).toEqual(first);
    expect(db.query<{ status: string; lease_generation: number }, [string]>(`
      SELECT status, lease_generation FROM btcc_state_claims WHERE claim_id = ?
    `).get(first.claimId)).toEqual({ status: "active", lease_generation: 2 });
    db.close();
  });
});

async function activationFixture() {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const publication = preparedPublication();
  let promotionCount = 0;
  let promotionState: string | null = null;
  const publications: ProjectWorkLedgerPublicationAdapter = {
    async observeCanonicalHead() { return publication.canonicalBase; },
    async prepareCommit() { throw new Error("unused"); },
    async loadProgram() { return null; },
    async listDeferredPrograms() { return []; },
    observePublicationState() { return "released"; },
    observeMutationClaimState() { return "released"; },
    async reconcileOrphanedPublications() {},
    async abort() {},
    async promoteAndObserve() {
      promotionState = db.query<{ semantic_state: string }, [string]>(
        "SELECT semantic_state FROM btcc_turns WHERE turn_id = ?",
      ).get("turn-project-activation")?.semantic_state ?? null;
      promotionCount += 1;
    },
  };
  const projectLedger = {
    publications,
    resolveProjectRoot: () => "/canonical/project",
  };
  const owner = testOwner(db);
  const turns = new SqliteTurnStateRepository(db, owner, projectLedger);
  const admission = new SqliteTurnAdmissionRepository(db, turns, owner, projectLedger);
  const command = runCommand();
  const inbox = await admission.recordInbound({ command, admissionInputHash: "input-sha" });
  const construction = await admission.acquireAdmissionConstructionClaim(inbox);
  const turn = await admission.constructTurn(inbox, construction);
  return {
    db,
    publication,
    turns,
    turn,
    outbox: new ProjectLedgerPromotionWriter(db),
    promotions: () => promotionCount,
    stateObservedAtPromotion: () => promotionState,
  };
}

function testOwner(db: Database) {
  return new SqliteRuntimeOwnerRegistry(db, {
    ownerId: "owner",
    hostId: "test-host",
    processId: 1,
    processStartedAtMs: 1,
  }, { isAlive: () => true });
}

function preparedPublication(): PreparedProjectLedgerPublication {
  const head = {
    schema: "butler.btcc-project-ledger-head.v1" as const,
    projectRoot: "/canonical/project",
    sourceSha256: "a".repeat(64),
    sourceFileCount: 2,
    storageSha256: "2".repeat(64),
    storageEntryCount: 4,
  };
  return {
    schema: "butler.btcc-project-ledger-publication.v1",
    canonicalBase: head,
    ledgerId: "ledger-project",
    programId: "program-project",
    logicalBundleRef: { id: "0".repeat(64), sha256: "0".repeat(64) },
    reviewedBundleRef: { id: "b".repeat(64), sha256: "c".repeat(64) },
    planningReviewRef: { id: "d".repeat(64), sha256: "e".repeat(64) },
    stagedLedgerRoot: "/staged/project",
    corePublication: {
      schema: "project-ledger.prepared-publication.v1",
      publicationId: "b".repeat(64),
      canonicalRoot: "/canonical/project",
      candidateRoot: "/staged/project",
      journalPath: "/journal/project.json",
      claimPath: "/journal/claim.json",
      base: head,
      candidateHead: { ...head, projectRoot: "/staged/project", sourceSha256: "f".repeat(64) },
    },
    manifestSha256: "1".repeat(64),
    entries: [],
  };
}

function ledgerCommit() {
  return {
    mutationId: "mutation-project-plan",
    turnId: "turn-project-activation",
    expectedTurnRevision: 2,
    mutation: {
      kind: "close_promotion_frontier" as const,
      cursor: {
        ledgerId: "ledger-project",
        programId: "program-project",
        expectedManifestRevision: 2,
      },
    },
  };
}

function runCommand() {
  return {
    kind: "run" as const,
    turnId: "turn-project-activation",
    sessionId: "session-project-activation",
    triggerKey: "trigger-project-activation",
    message: { messageId: "message-project-activation", content: "Build the project" },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low" as const,
      controls: { reasoningEffort: "low" },
      controlsHash: "controls-sha",
    },
    context: {
      userRef: "user-project",
      projectRef: "project-fixture",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: ["workspace:/project"],
    },
  };
}
