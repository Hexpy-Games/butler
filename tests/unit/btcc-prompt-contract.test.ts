import { expect, test } from "bun:test";
import {
  PROMPT_DUTY_IDS,
  PROMPT_PROHIBITION_IDS,
} from "../../packages/butler-agent/src/agent/btcc/core/prompt-contract.ts";
import {
  resolveDutyInstructions,
  resolveProhibitionInstructions,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/prompt-duty-catalog.ts";

test("every typed phase duty and prohibition has one prompt instruction", () => {
  expect(resolveDutyInstructions(PROMPT_DUTY_IDS).map((item) => item.id)).toEqual(
    [...PROMPT_DUTY_IDS],
  );
  expect(resolveProhibitionInstructions(PROMPT_PROHIBITION_IDS).map((item) => item.id))
    .toEqual([...PROMPT_PROHIBITION_IDS]);
  expect(resolveDutyInstructions(["select_exact_governing_spec_logical_ids"])[0]?.instruction)
    .toContain("governing Specs");
  expect(resolveDutyInstructions(["review_task_independently"])[0]?.instruction)
    .toContain("exactly one verdict per entry");
  expect(resolveDutyInstructions(["review_task_independently"])[0]?.instruction)
    .toContain("never introduce criteria from another Task");
});
