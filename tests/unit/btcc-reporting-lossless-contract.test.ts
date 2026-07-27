import { expect, test } from "bun:test";
import { consolidationSubmissionSchema } from "../../packages/butler-agent/src/agent/btcc/consolidation/submission-schema.ts";
import { resolveDutyInstructions } from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/prompt-duty-catalog.ts";

test("Consolidation cannot truncate required report facts by schema size", () => {
  const schema = JSON.stringify(consolidationSubmissionSchema);
  expect(schema).not.toContain("maxLength");
  expect(schema).not.toContain("maxItems");
});

test("Reporting must render required content instead of claiming it exists", () => {
  const instructions = resolveDutyInstructions([
    "render_final_dossier_truthfully",
    "guard_public_claims",
  ]).map((duty) => duty.instruction).join(" ");

  expect(instructions).toContain("preserve every user-required response element");
  expect(instructions).toContain("unless it is actually present");
});
