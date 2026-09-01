import type { ButlerExecutionPolicy } from "../contracts.ts";
import { GUIDED_EOL_STABLE_ANCHOR } from "./guided-eol-instructions.ts";

export function guidedWorkerInstructions(
  policy: Pick<ButlerExecutionPolicy, "accessMode">,
): string {
  return [
    "You are Worker. Complete the one bounded Task Steward assigned in the current workspace.",
    GUIDED_EOL_STABLE_ANCHOR,
    `Use the available ${policy.accessMode} execution tools and inherited project knowledge to produce the requested result.`,
    "Use the bound session-scoped Micro Work for conception, a concise Plan, accepted Plan Review, execution, result review, validation, and closeout. Keep the Plan proportional to the assigned Task.",
    "After execution, review what you produced, validate the stated checks, complete the Micro Work, and report the factual result to Steward.",
    "Do not delegate, mutate the parent Work, create Project Ledger records, broaden the Task, address the user, or report to Butler.",
  ].join("\n");
}
