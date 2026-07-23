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
      findings: ["Restore the requested implementation and validation."],
      findingSetRef,
    },
  } as GoalContractRevisionRequiredProduct;

  expect(() => bindGoalRevision({ goalRevision }, previousContractRef))
    .toThrow("did not change the proposed contract");
  expect(bindGoalRevision({ goalRevision }, ref("goal-contract-2"))).toEqual({
    kind: "review_revision",
    previousCandidateRef,
    reviewRef,
    findingSetRef,
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
      findings: ["A finding"],
      findingSetRef: ref("findings-1"),
    },
  } as GoalContractRevisionRequiredProduct;

  expect(() => bindGoalRevision({ goalRevision }, ref("goal-2")))
    .toThrow("not bound to its exact previous candidate");
});
