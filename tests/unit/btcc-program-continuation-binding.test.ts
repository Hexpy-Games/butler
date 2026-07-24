import { expect, test } from "bun:test";
import { contentRef } from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import { bindManagedProgram } from "../../packages/butler-agent/src/agent/btcc/work-ledger/program-authority.ts";
import type { WorkLedgerCommit } from "../../packages/butler-agent/src/agent/btcc/gateway-api.ts";
import type { AvailableSpecRevision } from "../../packages/butler-agent/src/agent/btcc/index.ts";
import { projectBindingCommit } from "./support/btcc-project-ledger-fixture.ts";

test("fresh continuation rebinds the complete current Planning authority", () => {
  const availableSpec = specRevision();
  const initial = projectBindingCommit();
  const binding = initial.commit.mutation;
  if (binding.kind !== "bind_program") throw new Error("bind Program fixture expected");
  const governingSpec = { ...availableSpec, body: "# Fixture spec\n" };
  const current = bindManagedProgram(null, binding, [availableSpec], [governingSpec]);
  const anchorRef = contentRef("deferral-anchor", { programId: current.programId });
  current.activeDeferral = { anchor: { ref: anchorRef } } as never;

  const goalContract = {
    ...initial.goalContract,
    ref: contentRef("goal-contract", { request: "Continue exact deferred work" }),
    request: "Continue exact deferred work",
    intendedResult: "Complete the deferred work",
    requiredOutcome: {
      outcomeId: "continued-required-outcome",
      sourceGoalFieldIds: ["request", "intended_result"] as const,
    },
  };
  const continuation = {
    kind: "deferred_goal" as const,
    inboxId: "inbox-continuation",
    ref: contentRef("continuation-binding", { anchorRef }),
    candidateId: "continuation-candidate",
    ledgerId: current.ledgerId,
    programId: current.programId,
    expectedManifestRevision: current.manifestRevision,
    baseManifestHash: "base-manifest-hash",
    sourceTurnId: "source-turn",
    originalGoalContractRef: initial.goalContract.ref,
    anchorRef,
  };
  const authority = {
    ...initial.authority,
    ref: contentRef("authority-revision", { goalContractRef: goalContract.ref }),
    goalContractRef: goalContract.ref,
    managedBinding: {
      ...initial.authority.managedBinding,
      expectedManifestRevision: current.manifestRevision,
      source: "deferred_goal" as const,
      continuationBinding: continuation,
    },
  };
  const commit: WorkLedgerCommit = {
    mutationId: "continuation-bind",
    turnId: "continuation-turn",
    expectedTurnRevision: 4,
    mutation: {
      kind: "bind_program",
      sessionId: "continuation-session",
      product: {
        kind: "goal_contract_accepted",
        planningContext: { observationResultIndex: [] },
        goalContract,
        authority,
        review: {
          ...binding.product.review,
          originalGoalContractRef: goalContract.ref,
          reviewedOutcomeIds: [goalContract.requiredOutcome.outcomeId],
          continuationBindingRef: continuation.ref,
        },
      },
    },
  };

  if (commit.mutation.kind !== "bind_program") throw new Error("bind Program fixture expected");
  const rebound = bindManagedProgram(
    current,
    commit.mutation,
    [availableSpec],
    [governingSpec],
  );

  expect(rebound).toMatchObject({
    manifestRevision: current.manifestRevision + 1,
    goalContractRef: goalContract.ref,
    authorityRef: authority.ref,
    requiredOutcomeId: "continued-required-outcome",
    governingSpecRefs: [availableSpec.revisionRef],
  });
});

function specRevision(): AvailableSpecRevision {
  return {
    logicalId: "SPEC-FIXTURE",
    parentId: "SPEC-FIXTURE-PARENT",
    concernId: "SPEC-FIXTURE",
    title: "Fixture spec",
    status: "active",
    revisionRef: contentRef("spec-revision", { logicalId: "SPEC-FIXTURE" }),
  };
}
