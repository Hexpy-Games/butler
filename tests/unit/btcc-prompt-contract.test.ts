import { expect, test } from "bun:test";
import {
  PROMPT_DUTY_IDS,
  PROMPT_PROHIBITION_IDS,
} from "../../packages/butler-agent/src/agent/btcc/core/prompt-contract.ts";
import {
  resolveDutyInstructions,
  resolveProhibitionInstructions,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/prompt-duty-catalog.ts";
import { openingSubmissionSchema } from
  "../../packages/butler-agent/src/agent/btcc/conception/submission-schemas.ts";
import { completionModeFor } from
  "../../packages/butler-agent/src/agent/btcc/conception/opening/fulfillment.ts";

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
  expect(resolveDutyInstructions(["conceive_scoped_correction"])[0]?.instruction)
    .toContain("stateInput.priorTaskReviewFindings");
  expect(resolveDutyInstructions(["review_continuation_coherence"])[0]?.instruction)
    .toContain("blocker");
  expect(resolveDutyInstructions(["review_continuation_coherence"])[0]?.instruction)
    .toContain("new Program");
  const openingRoute = resolveDutyInstructions(["choose_direct_assisted_or_deepen"])[0]
    ?.instruction ?? "";
  expect(openingRoute).toContain("requestObligation");
  expect(openingRoute).toContain("Do not weaken an imperative");
  expect(openingRoute).toContain("requiredResultKind: response_content");
  expect(openingRoute).toContain("target_change, persistent_artifact");
  expect(openingRoute).toContain("never a current target observation");
  expect(openingRoute).toContain("never route by keywords");
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
