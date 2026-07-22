import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SqliteLedgerContentionRuntime } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/ledger-contention/index.ts";
import {
  ProjectLedgerHeadConflictError,
  ProjectLedgerMutationClaimConflictError,
  ProjectLedgerPublicationClaimConflictError,
  type ProjectWorkLedgerPublicationAdapter,
} from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { projectBindingCommit } from "./support/btcc-project-ledger-fixture.ts";

describe("BTCC Project Ledger contention", () => {
  test("adopts pending bytes only after the exact winner has durable release proof", async () => {
    const fixture = contentionFixture();
    const input = acceptedBoundary(fixture.commit);
    const contentionId = fixture.runtime.relinquishBoundary(
      input as never,
      new ProjectLedgerPublicationClaimConflictError(
        new Error("owned"),
        fixture.root,
        "/operational/claim",
        fixture.baseHead,
        fixture.winnerId,
      ),
    );

    expect(fixture.contentionStatus(contentionId)).toBe("owned");
    expect(fixture.claimStatus()).toBe("relinquished");
    expect(fixture.activeClaim()).toBeNull();

    await fixture.runtime.scan();
    expect(fixture.contentionStatus(contentionId)).toBe("owned");
    expect(fixture.observedPublicationIds).toEqual([fixture.winnerId]);

    fixture.publicationState = "released";
    await fixture.runtime.scan();
    expect(fixture.contentionStatus(contentionId)).toBe("closed");
    expect(fixture.checkpoint().accepted_product_json).toBe('{"accepted":true}');
    expect(fixture.checkpoint().checkpoint_revision).toBe(2);
    fixture.db.close();
  });

  test("winner promotion supersedes old bytes and preserves the same Turn state", async () => {
    const fixture = contentionFixture();
    const input = acceptedBoundary(fixture.commit);
    const contentionId = fixture.runtime.relinquishBoundary(
      input as never,
      new ProjectLedgerPublicationClaimConflictError(
        new Error("owned"), fixture.root, "/operational/claim", fixture.baseHead,
        fixture.winnerId,
      ),
    );
    fixture.advanceCanonicalHead();

    await fixture.runtime.scan();

    expect(fixture.contentionStatus(contentionId)).toBe("closed");
    expect(fixture.checkpoint()).toMatchObject({
      checkpoint_revision: 3,
      accepted_product_json: null,
      active_claim_id: null,
    });
    expect(fixture.revisionStatus(3)).toBe("superseded_by_ledger_contention");
    expect(fixture.claimRevision()).toBe(3);
    fixture.db.close();
  });

  test("supersedes a stale accepted boundary for a head conflict even when Program bytes are unchanged", async () => {
    const fixture = contentionFixture();
    const input = acceptedBoundary(fixture.commit);
    const actual = { ...fixture.baseHead, sourceSha256: "advanced-source" };
    const contentionId = fixture.runtime.relinquishBoundary(
      input as never,
      new ProjectLedgerHeadConflictError(fixture.baseHead, actual),
    );

    await fixture.runtime.scan();

    expect(fixture.contentionStatus(contentionId)).toBe("closed");
    expect(fixture.checkpoint().checkpoint_revision).toBe(3);
    expect(fixture.claimRevision()).toBe(3);
    fixture.db.close();
  });

  test("a waiter is activated by durable state observed through another runtime instance", async () => {
    const fixture = contentionFixture();
    const input = acceptedBoundary(fixture.commit);
    const contentionId = fixture.runtime.relinquishBoundary(
      input as never,
      new ProjectLedgerPublicationClaimConflictError(
        new Error("owned"), fixture.root, "/claim", fixture.baseHead, fixture.winnerId,
      ),
    );
    const otherRuntime = new SqliteLedgerContentionRuntime(fixture.db, fixture.projectRuntime);
    const waiting = fixture.runtime.waitUntilResolved(contentionId);
    fixture.publicationState = "released";
    await otherRuntime.scan();
    await waiting;
    expect(fixture.contentionStatus(contentionId)).toBe("closed");
    fixture.db.close();
  });

  test("waits for an ordinary mutation claim and then adopts an unchanged boundary", async () => {
    const fixture = contentionFixture();
    const contentionId = fixture.runtime.relinquishBoundary(
      acceptedBoundary(fixture.commit) as never,
      new ProjectLedgerMutationClaimConflictError(
        new Error("ordinary mutation"),
        fixture.root,
        "/canonical/claim",
        fixture.baseHead,
        "mutation-claim-1",
      ),
    );

    await fixture.runtime.scan();
    expect(fixture.contentionStatus(contentionId)).toBe("owned");
    fixture.mutationState = "released";
    await fixture.runtime.scan();
    expect(fixture.contentionStatus(contentionId)).toBe("closed");
    expect(fixture.checkpoint().accepted_product_json).toBe('{"accepted":true}');
    fixture.db.close();
  });
});

function contentionFixture() {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  seedCheckpoint(db);
  const commit = projectBindingCommit().commit;
  const root = "/canonical/project";
  const winnerId = "winning-publication";
  let publicationState: "held" | "released" | "promoted" = "held";
  let mutationState: "held_exact" | "released" = "held_exact";
  let sourceSha256 = "base-source";
  const observedPublicationIds: string[] = [];
  const publications: ProjectWorkLedgerPublicationAdapter = {
    async observeCanonicalHead() { return { ...baseHead, sourceSha256 }; },
    async prepareCommit() { throw new Error("unused"); },
    async loadProgram() { return null; },
    async listDeferredPrograms() { return []; },
    observePublicationState(publicationId) {
      observedPublicationIds.push(publicationId);
      return publicationState;
    },
    observeMutationClaimState() { return mutationState; },
    async reconcileOrphanedPublications() {},
    async abort() {},
    async promoteAndObserve() {},
  };
  const baseHead = {
    schema: "butler.btcc-project-ledger-head.v1" as const,
    projectRoot: root,
    sourceSha256: "base-source",
    sourceFileCount: 1,
    storageSha256: "base-storage",
    storageEntryCount: 1,
  };
  const projectRuntime = {
    publications,
    resolveProjectRoot: () => root,
  };
  const runtime = new SqliteLedgerContentionRuntime(db, projectRuntime);
  return {
    db, runtime, commit, root, winnerId, observedPublicationIds, baseHead, projectRuntime,
    get publicationState() { return publicationState; },
    set publicationState(value) { publicationState = value; },
    get mutationState() { return mutationState; },
    set mutationState(value) { mutationState = value; },
    advanceCanonicalHead: () => { sourceSha256 = "advanced-source"; },
    contentionStatus: (id: string) => db.query<{ status: string }, [string]>(
      "SELECT status FROM btcc_ledger_contentions WHERE contention_id = ?",
    ).get(id)?.status,
    claimStatus: () => db.query<{ status: string }, []>(
      "SELECT status FROM btcc_state_claims WHERE claim_id = 'claim-1'",
    ).get()?.status,
    activeClaim: () => db.query<{ active_claim_id: string | null }, []>(
      "SELECT active_claim_id FROM btcc_checkpoints WHERE checkpoint_id = 'checkpoint-1'",
    ).get()?.active_claim_id,
    checkpoint: () => db.query<{
      checkpoint_revision: number;
      accepted_product_json: string | null;
      active_claim_id: string | null;
    }, []>("SELECT * FROM btcc_checkpoints WHERE checkpoint_id = 'checkpoint-1'").get()!,
    revisionStatus: (revision: number) => db.query<{ status: string }, [number]>(`
      SELECT status FROM btcc_phase_checkpoint_revisions
      WHERE checkpoint_id = 'checkpoint-1' AND checkpoint_revision = ?
    `).get(revision)?.status,
    claimRevision: () => db.query<{ checkpoint_revision: number }, []>(
      "SELECT checkpoint_revision FROM btcc_state_claims WHERE claim_id = 'claim-1'",
    ).get()!.checkpoint_revision,
  };
}

function seedCheckpoint(db: Database): void {
  db.query(`
    INSERT INTO btcc_checkpoints (
      checkpoint_id, turn_id, turn_revision, semantic_state, kind,
      checkpoint_revision, active_claim_id, accepted_product_json, is_active
    ) VALUES ('checkpoint-1', 'turn-project-bind', 0, 'contract_review', 'phase',
      2, 'claim-1', '{"accepted":true}', 1)
  `).run();
  db.query(`
    INSERT INTO btcc_state_claims (
      claim_id, turn_id, turn_revision, semantic_state, checkpoint_id,
      checkpoint_revision, execution_fence, owner_id, owner_generation,
      lease_generation, status
    ) VALUES ('claim-1', 'turn-project-bind', 0, 'contract_review', 'checkpoint-1',
      2, 0, 'owner-1', 1, 1, 'active')
  `).run();
  db.query(`
    INSERT INTO btcc_phase_checkpoint_revisions (
      checkpoint_id, checkpoint_revision, previous_revision_ref,
      pending_submission_ref, pending_submission_json,
      state_claim_id, execution_fence, status
    ) VALUES ('checkpoint-1', 2, 'revision-1', 'submission-1',
      '{"submission":"exact"}', 'claim-1', 0, 'pending_boundary')
  `).run();
}

function acceptedBoundary(commit: ReturnType<typeof projectBindingCommit>["commit"]) {
  return {
    turn: {
      turnId: "turn-project-bind",
      revision: 0,
      semanticState: "contract_review",
      managed: {},
    },
    claim: {
      claimId: "claim-1",
      turnId: "turn-project-bind",
      turnRevision: 0,
      semanticState: "contract_review",
      checkpointId: "checkpoint-1",
      checkpointRevision: 2,
      executionFence: 0,
    },
    transition: {
      kind: "accept_goal_contract",
      successor: "planning",
      product: commit.mutation.kind === "bind_program" ? commit.mutation.product : null,
      ledgerCommit: commit,
    },
  };
}
