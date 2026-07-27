import { expect, test } from "bun:test";
import { consolidationGoalSubject } from
  "../../packages/butler-agent/src/agent/btcc/consolidation/consolidation.ts";
import { contentRef } from
  "../../packages/butler-agent/src/agent/btcc/gateway-api.ts";
import type { GoalContractAcceptedProduct } from
  "../../packages/butler-agent/src/agent/btcc/conception/index.ts";
import type { ReviewedManagedProgramState } from
  "../../packages/butler-agent/src/agent/btcc/work-ledger/index.ts";
import { acceptedGoalFixture } from "./support/btcc-stopped-work-fixture.ts";

test("stopped finalization Consolidation assesses the closed Program original GoalContract", () => {
  const original = acceptedGoalFixture().goalContract;
  const fresh = structuredClone(acceptedGoalFixture()) as GoalContractAcceptedProduct;
  const { ref: _originalRef, ...originalBody } = fresh.goalContract;
  const freshBody = {
    ...originalBody,
    request: "Only finish the continuation handoff",
    fields: [
      { ...fresh.goalContract.fields[0], statement: "Finish the handoff" },
      fresh.goalContract.fields[1],
    ] as typeof fresh.goalContract.fields,
  };
  fresh.goalContract = {
    ref: contentRef("goal-contract", freshBody),
    ...freshBody,
  };
  const program = {
    planningState: "reviewed",
    frontier: "closed",
    goalContractRef: original.ref,
  } as ReviewedManagedProgramState;
  fresh.authority.managedBinding.continuationBinding = {
    kind: "stopped_finalization",
    inboxId: "inbox-finalization",
    ref: contentRef("continuation-binding", { candidateId: "candidate-finalization" }),
    candidateId: "candidate-finalization",
    ledgerId: "session:session-fixture",
    programId: "program-session",
    expectedManifestRevision: 3,
    baseManifestHash: "manifest-hash",
    sourceTurnId: "turn-stopped",
    originalGoalContractRef: original.ref,
    anchorRef: contentRef("anchor", { sourceTurnId: "turn-stopped" }),
    context: {
      originalGoalContract: original,
      blocker: { sourceState: "consolidation", reason: "stopped", readiness: {} },
      frontier: { openWorkRefs: [], openTaskRefs: [] },
      finalization: { resumeAt: "consolidation", closedProgram: program },
    },
  };

  expect(consolidationGoalSubject({
    goalAcceptance: fresh,
    finalizationOriginalGoalContract: original,
  }, program, fresh)).toBe(original);
  expect(() => consolidationGoalSubject({
    goalAcceptance: fresh,
    finalizationOriginalGoalContract: fresh.goalContract,
  }, program, fresh)).toThrow("original GoalContract authority changed");
});
