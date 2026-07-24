import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createProjectWorkLedgerPublicationAdapter,
  readCanonicalProjectLedger,
  ProjectLedgerHeadConflictError,
  ProjectLedgerPublicationClaimConflictError,
} from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { prepareTaskAttempt } from
  "../../packages/butler-agent/src/agent/btcc/work/prepare-task-attempt.ts";
import {
  clearProjectFixtures,
  canonicalMutationId,
  projectBindingCommit,
  projectFixture,
  reviewedPlan,
  successfulResult,
  successfulReview,
} from "./support/btcc-project-ledger-fixture.ts";
import { contentRef } from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import { planningCandidateBundleEntries } from
  "../../packages/butler-agent/src/agent/btcc/planning/index.ts";

afterEach(clearProjectFixtures);

describe("BTCC Project Work Ledger prepared publication", () => {
  test("hydrates canonical Project authority through the accepted Task lifecycle", async () => {
    const fixture = await projectFixture();
    const adapter = createProjectWorkLedgerPublicationAdapter({
      stagingRoot: join(fixture.root, "staging"),
    });
    const binding = projectBindingCommit();
    const bind = await adapter.prepareCommit({
      projectRoot: fixture.ledgerRoot,
      expectedBase: await adapter.observeCanonicalHead(fixture.ledgerRoot),
      commit: binding.commit,
    });
    expect(bind.program).toMatchObject({
      planningState: "unplanned",
      manifestRevision: 1,
      governingSpecRefs: [bind.program.availableSpecRefs[0]],
    });
    expect(bind.program.availableSpecRefs).toHaveLength(1);
    await adapter.promoteAndObserve(bind.publication);
    const canonical = await readCanonicalProjectLedger(fixture.ledgerRoot);
    expect(canonical.records.find((record) => record.id === "SPEC-FIXTURE")?.body)
      .toContain("Fixture spec");
    expect(canonical.records.some((record) =>
      record.kind === "reference" && record.body?.includes(binding.goalContract.ref.id),
    )).toBe(true);

    const accepted = reviewedPlan({
      goalContractRef: binding.goalContract.ref,
      authorityRef: binding.authority.ref,
      availableSpecRefs: bind.program.availableSpecRefs,
      governingSpecSelections: [bind.program.availableSpecs[0]!.logicalId],
      requireGoverningSpec: true,
    });
    const install = await commitMutation(adapter, fixture.ledgerRoot, {
        mutationId: "mutation-project-plan", turnId: "turn-project-plan",
        expectedTurnRevision: 4,
        mutation: { kind: "install_reviewed_plan", product: accepted },
    });
    expect(install.program).toMatchObject({
      planningState: "reviewed", manifestRevision: 2,
      governingSpecRefs: bind.program.availableSpecRefs,
    });
    await adapter.promoteAndObserve(install.publication);
    for (const entry of planningCandidateBundleEntries(accepted.candidate)) {
      const found = fixture.core.resolveRecord(fixture.ledgerRoot, {
        kind: "reference", id: entry.ref.id,
      });
      expect(fixture.core.readRecordBody(found.filePath)).toBe(entry.semanticBytes);
    }
    expect(await adapter.loadProgram(fixture.ledgerRoot, "program-fixture"))
      .toEqual(install.program);
    expect(fixture.core.resolveRecord(fixture.ledgerRoot, {
      kind: "spec", id: bind.program.availableSpecs[0]!.logicalId,
    }).record.id).toBe(bind.program.availableSpecs[0]!.logicalId);
    if (install.program.planningState !== "reviewed") throw new Error("reviewed Program expected");

    const attempt = await prepareTaskAttempt({
      turnId: "turn-project-task", turnRevision: 6, program: install.program,
      task: install.program.currentTask, artifacts: {} as never,
    });
    const selected = await commitMutation(adapter, fixture.ledgerRoot, {
      mutationId: "mutation-project-select", turnId: "turn-project-task",
      expectedTurnRevision: 6,
      mutation: { kind: "select_attempt", cursor: cursor(install.program), attempt },
    });
    expect(selected.program).toMatchObject({
      manifestRevision: 3, currentTask: { status: "selected" },
    });
    await adapter.promoteAndObserve(selected.publication);
    if (selected.program.planningState !== "reviewed") throw new Error("reviewed Program expected");

    const result = successfulResult(selected.program, attempt);
    const submitted = await commitMutation(adapter, fixture.ledgerRoot, {
      mutationId: "mutation-project-result", turnId: "turn-project-task",
      expectedTurnRevision: 7,
      mutation: { kind: "attach_result", cursor: cursor(selected.program), product: result },
    });
    if (submitted.program.planningState !== "reviewed") throw new Error("reviewed Program expected");
    expect(submitted.program.currentTask.status).toBe("result_submitted");
    await adapter.promoteAndObserve(submitted.publication);

    const review = successfulReview(submitted.program, attempt, result);
    const reviewed = await commitMutation(adapter, fixture.ledgerRoot, {
      mutationId: "mutation-project-review", turnId: "turn-project-task",
      expectedTurnRevision: 8,
      mutation: { kind: "attach_review", cursor: cursor(submitted.program), product: review },
    });
    expect(reviewed.program).toMatchObject({
      manifestRevision: 5, currentTask: { status: "accepted" },
    });
    await adapter.promoteAndObserve(reviewed.publication);
    expect((await adapter.loadProgram(fixture.ledgerRoot, "program-fixture"))?.manifestRevision)
      .toBe(5);
    expect(fixture.core.buildIndex(fixture.ledgerRoot).records
      .filter((record: { kind: string }) => record.kind === "spec")
      .map((record: { id: string }) => record.id)).toEqual(["SPEC-FIXTURE"]);
  });

  test("persists a Planning-stage deferral before any Plan or Work exists", async () => {
    const fixture = await projectFixture();
    const adapter = createProjectWorkLedgerPublicationAdapter({
      stagingRoot: join(fixture.root, "staging"),
    });
    const binding = projectBindingCommit();
    const bound = await adapter.prepareCommit({
      projectRoot: fixture.ledgerRoot,
      expectedBase: await adapter.observeCanonicalHead(fixture.ledgerRoot),
      commit: binding.commit,
    });
    await adapter.promoteAndObserve(bound.publication);
    const blockerBody = {
      programId: bound.program.programId,
      sourceState: "planning" as const,
      sourceGoalFieldIds: ["request", "intended_result"] as const,
      sourceRequiredOutcomeRefs: [bound.program.requiredOutcomeId] as [string],
      reason: "Fixture user authority is required.",
      readiness: {
        kind: "user_authority" as const,
        requiredAuthorityScopeRefs: ["authority:fixture"] as [string],
      },
    };
    const blocker = { ref: contentRef("managed-blocker", blockerBody), ...blockerBody };
    const anchorBody = {
      programId: bound.program.programId,
      goalContractRef: bound.program.goalContractRef,
      authorityRef: bound.program.authorityRef,
      planAuthority: {
        kind: "pre_plan" as const,
        sourcePhaseEnvelopeRef: contentRef("phase-envelope", "planning"),
      },
      openWorkRefs: [], openTaskRefs: [], workspaceRefs: [], workspaceRevisionRefs: [],
      promotionContext: { kind: "not_promotion" as const },
      blockerRef: blocker.ref,
      sourceTurnId: "turn-project-deferral",
      sourceTurnRevision: 5,
    };
    const product = {
      kind: "managed_deferral" as const,
      blocker,
      anchor: { ref: contentRef("deferral-anchor", anchorBody), ...anchorBody },
    };
    const deferred = await commitMutation(adapter, fixture.ledgerRoot, {
      mutationId: "mutation-project-deferral", turnId: "turn-project-deferral",
      expectedTurnRevision: 5,
      mutation: {
        kind: "accept_managed_deferral",
        cursor: cursor(bound.program),
        product,
      },
    });

    expect(deferred.program).toMatchObject({
      planningState: "unplanned",
      manifestRevision: 2,
      activeDeferral: product,
    });
    await adapter.promoteAndObserve(deferred.publication);
    expect(await adapter.loadProgram(fixture.ledgerRoot, bound.program.programId))
      .toEqual(deferred.program);
  });

  test("rejects a changed canonical base instead of rebasing reviewed meaning", async () => {
    const fixture = await projectFixture();
    const adapter = createProjectWorkLedgerPublicationAdapter({ stagingRoot: join(fixture.root, "staging") });
    const expectedBase = await adapter.observeCanonicalHead(fixture.ledgerRoot);
    fixture.core.createRecord(fixture.ledgerRoot, {
      kind: "reference", id: "CONCURRENT-CHANGE", title: "Concurrent change",
      status: "active", body: "The canonical head changed.",
    });
    await expect(adapter.prepareCommit({
      projectRoot: fixture.ledgerRoot, expectedBase, commit: projectBindingCommit().commit,
    })).rejects.toBeInstanceOf(ProjectLedgerHeadConflictError);
  });

  test("blocks ordinary canonical mutations while a publication owns the root", async () => {
    const fixture = await projectFixture();
    const adapter = createProjectWorkLedgerPublicationAdapter({ stagingRoot: join(fixture.root, "staging") });
    const expectedBase = await adapter.observeCanonicalHead(fixture.ledgerRoot);
    await adapter.prepareCommit({
      projectRoot: fixture.ledgerRoot, expectedBase, commit: projectBindingCommit().commit,
    });
    const canonicalWriters = [
      () => fixture.core.initProject({
        project: fixture.ledgerRoot, id: "fixture-project", name: "Fixture",
      }),
      () => fixture.core.createRecord(fixture.ledgerRoot, {
        kind: "reference", id: "CONCURRENT-CHANGE", title: "Concurrent change",
        status: "active", body: "The canonical head changed.",
      }),
      () => fixture.core.createWork(fixture.ledgerRoot, {
        id: "W-CONCURRENT", title: "Concurrent Work",
      }),
      () => fixture.core.createTask(fixture.ledgerRoot, {
        id: "T-CONCURRENT", title: "Concurrent Task", work: "W-CONCURRENT",
      }),
      () => fixture.core.createAttempt(fixture.ledgerRoot, {
        id: "A-CONCURRENT", task: "T-CONCURRENT",
      }),
      () => fixture.core.migrateDocs(fixture.ledgerRoot, { write: true }),
    ];
    for (const write of canonicalWriters) {
      expect(write).toThrow("blocked by an active publication");
    }
  });

  test("gives one publication the root and rejects a typed competing Turn", async () => {
    const fixture = await projectFixture();
    const adapter = createProjectWorkLedgerPublicationAdapter({ stagingRoot: join(fixture.root, "staging") });
    const expectedBase = await adapter.observeCanonicalHead(fixture.ledgerRoot);
    const firstCommit = projectBindingCommit().commit;
    const publication = await adapter.prepareCommit({
      projectRoot: fixture.ledgerRoot, expectedBase, commit: firstCommit,
    });
    expect((await adapter.prepareCommit({
      projectRoot: fixture.ledgerRoot, expectedBase, commit: firstCommit,
    })).publication).toEqual(publication.publication);
    const competing = projectBindingCommit().commit;
    competing.turnId = "turn-project-bind-competing";
    competing.mutationId = canonicalMutationId(competing, null);
    await expect(adapter.prepareCommit({
      projectRoot: fixture.ledgerRoot, expectedBase, commit: competing,
    })).rejects.toBeInstanceOf(ProjectLedgerPublicationClaimConflictError);
    await adapter.promoteAndObserve(publication.publication);
    await adapter.promoteAndObserve(publication.publication);
    await expect(adapter.prepareCommit({
      projectRoot: fixture.ledgerRoot, expectedBase, commit: competing,
    })).rejects.toBeInstanceOf(ProjectLedgerHeadConflictError);
  });

  test("rejects physical candidate drift without changing canonical storage", async () => {
    const fixture = await projectFixture();
    const adapter = createProjectWorkLedgerPublicationAdapter({ stagingRoot: join(fixture.root, "staging") });
    const before = await adapter.observeCanonicalHead(fixture.ledgerRoot);
    const prepared = await adapter.prepareCommit({
      projectRoot: fixture.ledgerRoot, expectedBase: before,
      commit: projectBindingCommit().commit,
    });
    writeFileSync(join(prepared.publication.stagedLedgerRoot, "untracked-drift.txt"), "drift\n");
    await expect(adapter.promoteAndObserve(prepared.publication))
      .rejects.toThrow("Project Ledger publication index is missing or stale");
    expect(await adapter.observeCanonicalHead(fixture.ledgerRoot)).toEqual(before);
    await adapter.abort(prepared.publication);
  });

  test("logical Project heads are path and timestamp independent", async () => {
    const left = await projectFixture();
    const right = await projectFixture();
    const adapter = createProjectWorkLedgerPublicationAdapter({ stagingRoot: join(left.root, "staging") });
    const leftHead = await adapter.observeCanonicalHead(left.ledgerRoot);
    const rightHead = await adapter.observeCanonicalHead(right.ledgerRoot);
    expect(leftHead.sourceSha256).toBe(rightHead.sourceSha256);
    expect(leftHead.sourceFileCount).toBe(rightHead.sourceFileCount);
  });

  test("startup reconciliation repairs a missing claim and aborts its unreferenced intent", async () => {
    const fixture = await projectFixture();
    const adapter = createProjectWorkLedgerPublicationAdapter({ stagingRoot: join(fixture.root, "staging") });
    const prepared = await adapter.prepareCommit({
      projectRoot: fixture.ledgerRoot,
      expectedBase: await adapter.observeCanonicalHead(fixture.ledgerRoot),
      commit: projectBindingCommit().commit,
    });
    expect(existsSync(prepared.publication.stagedLedgerRoot)).toBe(true);
    unlinkSync(prepared.publication.corePublication.claimPath);
    await adapter.reconcileOrphanedPublications([]);
    expect(existsSync(prepared.publication.stagedLedgerRoot)).toBe(false);
    expect(() => fixture.core.createRecord(fixture.ledgerRoot, {
      kind: "reference", id: "AFTER-RECONCILE", title: "After reconcile",
      status: "active", body: "available",
    })).not.toThrow();
  });
});

function cursor(program: { ledgerId: string; programId: string; manifestRevision: number }) {
  return {
    ledgerId: program.ledgerId, programId: program.programId,
    expectedManifestRevision: program.manifestRevision,
  };
}

async function commitMutation(
  adapter: ReturnType<typeof createProjectWorkLedgerPublicationAdapter>,
  projectRoot: string,
  commit: Parameters<typeof adapter.prepareCommit>[0]["commit"],
) {
  const mutation = commit.mutation;
  const programId = mutation.kind === "bind_program"
    ? mutation.product.authority.managedBinding.programId
    : mutation.kind === "install_reviewed_plan"
      ? mutation.product.candidate.programId
      : mutation.cursor.programId;
  commit.mutationId = canonicalMutationId(
    commit,
    await adapter.loadProgram(projectRoot, programId),
  );
  return adapter.prepareCommit({
    projectRoot, expectedBase: await adapter.observeCanonicalHead(projectRoot), commit,
  });
}
