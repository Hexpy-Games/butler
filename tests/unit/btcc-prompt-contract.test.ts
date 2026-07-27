import { expect, test } from "bun:test";
import {
  PROMPT_DUTY_IDS,
  PROMPT_PROHIBITION_IDS,
} from "../../packages/butler-agent/src/agent/btcc/core/prompt-contract.ts";
import {
  resolveDutyInstructions,
  resolveProhibitionInstructions,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/prompt-duty-catalog.ts";
import {
  goalCandidateSubmissionSchema,
  goalReviewSubmissionSchema,
  openingSubmissionSchema,
  openingSubmissionSchemaFor,
} from
  "../../packages/butler-agent/src/agent/btcc/conception/submission-schemas.ts";
import { completionModeFor } from
  "../../packages/butler-agent/src/agent/btcc/conception/opening/fulfillment.ts";
import { decodeUserArtifactTargetRequirement } from
  "../../packages/butler-agent/src/agent/btcc/conception/user-artifact-target-requirement.ts";

test("every typed phase duty and prohibition has one prompt instruction", () => {
  expect(resolveDutyInstructions(PROMPT_DUTY_IDS).map((item) => item.id)).toEqual(
    [...PROMPT_DUTY_IDS],
  );
  expect(resolveProhibitionInstructions(PROMPT_PROHIBITION_IDS).map((item) => item.id))
    .toEqual([...PROMPT_PROHIBITION_IDS]);
  expect(resolveDutyInstructions(["map_governing_spec_applicability"])[0]?.instruction)
    .toContain("changeObligations");
  expect(resolveDutyInstructions(["map_governing_spec_applicability"])[0]?.instruction)
    .toContain("preservationConstraints");
  expect(resolveDutyInstructions(["review_task_independently"])[0]?.instruction)
    .toContain("exactly one verdict per entry");
  expect(resolveDutyInstructions(["review_task_independently"])[0]?.instruction)
    .toContain("never introduce criteria from another Task");
  expect(resolveDutyInstructions(["review_task_independently"])[0]?.instruction)
    .toContain("directSuccessorHandoffs");
  expect(resolveDutyInstructions(["review_task_independently"])[0]?.instruction)
    .toContain("successor-owned persistent test");
  expect(resolveDutyInstructions(["review_executability"])[0]?.instruction)
    .toContain("successor-owned path");
  expect(resolveDutyInstructions(["review_executability"])[0]?.instruction)
    .toContain("several separable");
  expect(resolveDutyInstructions(["author_smallest_sufficient_plan"])[0]?.instruction)
    .toContain("never collapse a layered feature");
  expect(resolveDutyInstructions(["author_smallest_sufficient_plan"])[0]?.instruction)
    .toContain("Never create a discovery Task inside a graph");
  expect(resolveDutyInstructions(["author_smallest_sufficient_plan"])[0]?.instruction)
    .toContain("existing conforming behavior");
  expect(resolveDutyInstructions(["review_plan_exactly"])[0]?.instruction)
    .toContain("Never expand the Goal");
  expect(resolveDutyInstructions(["review_task_independently"])[0]?.instruction)
    .toContain("Do not choose or reproduce opaque");
  expect(resolveDutyInstructions(["classify_correction_kind"])[0]?.instruction)
    .toContain("verification-ownership defect");
  expect(resolveDutyInstructions(["classify_correction_kind"])[0]?.instruction)
    .toContain("materially equivalent implementation findings recur");
  expect(resolveDutyInstructions(["author_complete_impact_map"])[0]?.instruction)
    .toContain("exact accepted Task revision");
  expect(resolveDutyInstructions(["author_complete_impact_map"])[0]?.instruction)
    .toContain("requires rework or replan");
  expect(resolveDutyInstructions(["conceive_scoped_correction"])[0]?.instruction)
    .toContain("stateInput.priorTaskReviewFindings");
  expect(resolveDutyInstructions(["review_continuation_coherence"])[0]?.instruction)
    .toContain("blocker");
  expect(resolveDutyInstructions(["review_continuation_coherence"])[0]?.instruction)
    .toContain("new Program");
  const persistenceAuthoring = resolveDutyInstructions(["define_artifact_persistence"])[0]
    ?.instruction ?? "";
  expect(persistenceAuthoring).toContain("userArtifactTargetRequirement");
  expect(persistenceAuthoring)
    .toContain("reviewed_artifact_bytes_at_admitted_target_required");
  expect(persistenceAuthoring).toContain("internally persisted lifecycle records");
  expect(persistenceAuthoring).toContain("independent of route, Task, tool, or storage");
  expect(persistenceAuthoring).toContain("no_user_artifact_target");
  const persistenceReview = resolveDutyInstructions(["review_artifact_persistence"])[0]
    ?.instruction ?? "";
  expect(persistenceReview).toContain("user-requested, reviewed product bytes");
  expect(persistenceReview).toContain("internally persisted lifecycle records");
  expect(persistenceReview).toContain("independent of route, Task, tool, or storage");
  const openingRoute = resolveDutyInstructions(["choose_direct_assisted_or_deepen"])[0]
    ?.instruction ?? "";
  expect(openingRoute).toContain("requestObligation");
  expect(openingRoute).toContain("Do not weaken an imperative");
  expect(openingRoute).toContain("requiredResultKind: response_content");
  expect(openingRoute).toContain("target_change, persistent_artifact");
  expect(openingRoute).toContain("never a current target observation");
  expect(openingRoute).toContain("managed_program_continuation");
  expect(openingRoute).toContain("candidate-free bounded new request");
  expect(openingRoute).toContain("never route by keywords");
});

test("Goal authoring distinguishes user artifacts from durable BTCC records", () => {
  const schema = JSON.stringify(goalCandidateSubmissionSchema([]));
  expect(schema).toContain("userArtifactTargetRequirement");
  expect(schema).toContain("no_user_artifact_target");
  expect(schema).toContain("reviewed_artifact_bytes_at_admitted_target_required");
  expect(schema).not.toContain('"artifactPersistence"');
  expect(schema).not.toContain("userArtifactPersistence");
  expect(decodeUserArtifactTargetRequirement("no_user_artifact_target"))
    .toBe("not_required");
  expect(decodeUserArtifactTargetRequirement(
    "reviewed_artifact_bytes_at_admitted_target_required",
  ))
    .toBe("required");
  expect(() => decodeUserArtifactTargetRequirement("required")).toThrow();
});

test("Opening derives route mode from one typed required result", () => {
  const schema = JSON.stringify(openingSubmissionSchema);
  expect(schema).toContain("requiredResultKind");
  expect(schema).toContain("target_change");
  expect(schema).not.toContain("completionMode");
  expect(completionModeFor("response_content")).toBe("answer_only");
  expect(completionModeFor("current_observation"))
    .toBe("bounded_observation_then_answer");
  expect(completionModeFor("target_change")).toBe("managed_effect_or_artifact");
});

test("Opening and Goal Review preserve one exact managed Program proposal", () => {
  const noCandidates = JSON.stringify(openingSubmissionSchemaFor([]));
  expect(noCandidates).not.toContain("managed_program_continuation");
  expect(noCandidates).not.toContain("cancel_work");

  const withCandidate = JSON.stringify(openingSubmissionSchemaFor(["candidate-exact"]));
  expect(withCandidate).toContain("managed_program_continuation");
  expect(withCandidate).toContain("candidate-exact");
  expect(withCandidate).not.toContain("candidate-unavailable");

  const review = JSON.stringify(goalReviewSubmissionSchema([], "candidate-exact"));
  expect(review).toContain("continuationDecision");
  expect(review).toContain("candidate-exact");
  expect(review).toContain("bind");
  expect(review).toContain("reject");
});
