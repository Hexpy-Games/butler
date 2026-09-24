import type { DurableWorkExecutionMode } from "../work/index.ts";
import { rejection } from "./actionable-rejection.ts";

export const ROLE_EXECUTION_MODES: Record<"butler" | "steward" | "worker", string[]> = {
  butler: ["direct", "steward"],
  steward: ["direct", "workers"],
  worker: ["direct"],
};

/** Names the tools the reviewed Plan's execution ownership allows instead. */
export function unavailableForExecutionMode(
  mode: DurableWorkExecutionMode | undefined,
  state: Record<string, unknown>,
  role: "butler" | "steward" | "worker" = "steward",
) {
  const reason = role === "butler" && mode !== "steward"
    ? "To delegate this Work, revise the same Plan with execution_mode: steward, preserving completed action keys and results, then review and call delegate_to_steward. This delegation call was not run."
    : mode === "steward"
    ? "The reviewed Plan assigns execution to Steward. Call delegate_to_steward with the remaining objective and constraints; Butler manages and reports the result. This execution call was not run."
    : mode === "workers"
    ? "The reviewed Plan assigns execution to Workers. Use Worker management for execution; Steward retains integration, review, validation, and reporting. This execution call was not run."
    : mode === "direct"
      ? "The reviewed Plan assigns execution directly to Steward; Worker assignment is unavailable for this Plan. Execute the action with direct tools or revise the Plan."
      : "The current Plan has no reviewed execution ownership. Replace and review the Plan with direct or workers before new owned execution.";
  const alternatives = mode === "steward"
    ? ["delegate_to_steward", "steer_steward", "cancel_steward", "replace_work_plan"]
    : mode === "workers"
    ? ["delegate_to_worker", "steer_worker", "wait_for_worker", "replace_work_plan"]
    : mode === "direct"
    ? ["direct execution tools of the current surface", "replace_work_plan"]
    : ["replace_work_plan", "record_work_review"];
  return rejection({ code: "tool_unavailable", reason, alternatives, state: { ...state, role } });
}
