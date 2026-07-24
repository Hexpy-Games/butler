import { describe, expect, test } from "bun:test";
import { contentRef } from
  "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import { projectPlanningRevision } from
  "../../packages/butler-agent/src/agent/btcc/planning/planning.ts";
import type { PlanningRevisionRequiredProduct } from
  "../../packages/butler-agent/src/agent/btcc/planning/review-contracts.ts";

describe("BTCC Planning revision projection", () => {
  test("preserves frozen review lineage when the previous candidate is a Draft", () => {
    const candidateRef = contentRef("planning-draft", { revision: 1 });
    const findingSetRef = contentRef("planning-finding-set", { revision: 1 });
    const revision: PlanningRevisionRequiredProduct = {
      kind: "planning_revision_required",
      candidate: {
        kind: "planning_draft",
        ref: candidateRef,
        ledgerId: "ledger-1",
        programId: "program-1",
        observedManifestRevision: 1,
        goalContractRef: contentRef("goal-contract", { revision: 1 }),
        authorityRef: contentRef("authority", { revision: 1 }),
        governingSpecRefs: [],
        submission: {},
        validationFindings: [{
          code: "planned_graph_mismatch",
          message: "The submitted graph is structurally inconsistent.",
        }],
      },
      observationResultIndex: [],
      review: {
        ref: contentRef("planning-review", { revision: 1 }),
        candidateRef,
        originalGoalContractRef: contentRef("goal-contract", { revision: 1 }),
        verdict: "revision_required",
        findings: ["planned_graph_mismatch"],
        findingSet: {
          ref: findingSetRef,
          candidateRef,
          findings: [],
        },
        findingSetRef,
      },
    };

    expect(projectPlanningRevision(revision)).toEqual({
      previousPlanCandidate: revision.candidate,
      planningReviewFindings: revision.review.findings,
      previousCandidateRef: candidateRef,
      findingSetRef,
      priorPlanningReview: revision.review,
    });
  });
});
