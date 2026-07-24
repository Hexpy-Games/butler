import { expect, test } from "bun:test";
import { bindGoalRevision } from
  "../../packages/butler-agent/src/agent/btcc/conception/deliberate-goal.ts";
import type { GoalContractRevisionRequiredProduct } from
  "../../packages/butler-agent/src/agent/btcc/conception/managed-contracts.ts";

const ref = (id: string) => ({ id, sha256: `${id}-sha256` });

test("a reviewed Goal candidate must change bytes and preserve exact revision lineage", () => {
  const previousContractRef = ref("goal-contract-1");
  const previousCandidateRef = ref("goal-candidate-1");
  const reviewRef = ref("goal-review-1");
  const findingSetRef = ref("goal-findings-1");
  const findingRef = ref("goal-finding-1");
  const finding = {
    ref: findingRef,
    rootCauseKey: "missing_requested_implementation",
    affectedSubjectIds: ["goal:request"],
    statement: "Restore the requested implementation and validation.",
    priority: "P1",
    scopeRelation: "current_goal",
    recommendedDisposition: "required_now",
    dispositionRationale: "The candidate omitted the requested implementation.",
  };
  const decisions = [{
    findingRef,
    decision: "apply_now" as const,
    rationale: "Restore the omitted Goal obligation.",
  }];
  const goalRevision = {
    kind: "goal_contract_revision_required",
    candidate: {
      ref: previousCandidateRef,
      proposedContract: { ref: previousContractRef },
      proposedStrategy: "managed",
      revisionOrigin: { kind: "initial" },
    },
    review: {
      ref: reviewRef,
      candidateRef: previousCandidateRef,
      originalMessageId: "message-1",
      originalMessageSha256: "message-sha256",
      verdict: "revision_required",
      findings: [finding],
      findingSet: {
        ref: findingSetRef,
        candidateRef: previousCandidateRef,
        findingRefs: [findingRef],
      },
      findingSetRef,
    },
  } as unknown as GoalContractRevisionRequiredProduct;

  expect(() => bindGoalRevision({ goalRevision }, previousContractRef, decisions))
    .toThrow("did not change the proposed contract");
  expect(bindGoalRevision({ goalRevision }, ref("goal-contract-2"), decisions)).toEqual({
    kind: "review_revision",
    previousCandidateRef,
    reviewRef,
    findingSetRef,
    findingDecisions: decisions,
  });
  const disputed = [{
    findingRef,
    decision: "dispute" as const,
    rationale: "The frozen Goal already contains the claimed obligation.",
  }];
  expect(bindGoalRevision({ goalRevision }, previousContractRef, disputed)).toEqual({
    kind: "review_revision",
    previousCandidateRef,
    reviewRef,
    findingSetRef,
    findingDecisions: disputed,
  });
});

test("a Goal review cannot be attached to a different candidate", () => {
  const goalRevision = {
    kind: "goal_contract_revision_required",
    candidate: {
      ref: ref("candidate-1"),
      proposedContract: { ref: ref("goal-1") },
      proposedStrategy: "managed",
      revisionOrigin: { kind: "initial" },
    },
    review: {
      ref: ref("review-1"),
      candidateRef: ref("candidate-2"),
      originalMessageId: "message-1",
      originalMessageSha256: "message-sha256",
      verdict: "revision_required",
      findings: [],
      findingSet: {
        ref: ref("findings-1"),
        candidateRef: ref("candidate-2"),
        findingRefs: [],
      },
      findingSetRef: ref("findings-1"),
    },
  } as unknown as GoalContractRevisionRequiredProduct;

  expect(() => bindGoalRevision({ goalRevision }, ref("goal-2")))
    .toThrow("not bound to its exact previous candidate");
});
