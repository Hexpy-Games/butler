import type { PhaseContinuity } from
  "../../tools/m1-compact-replay.ts";

/** The single semantic parser for model-authored PhaseContinuity arguments. */
export function parseCompactReplayPhaseContinuity(
  args: Record<string, unknown>,
): PhaseContinuity {
  return {
    objectiveState: requiredText(args.objective_state, "objective_state", 1_200),
    integratedDecisions: textArray(
      args.integrated_decisions,
      "integrated_decisions",
    ),
    unresolvedQuestions: textArray(
      args.unresolved_questions,
      "unresolved_questions",
    ),
    nextBatchPurpose: requiredText(
      args.next_batch_purpose,
      "next_batch_purpose",
      800,
    ),
    publicActivity: requiredText(args.public_activity, "public_activity", 500),
  };
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength) {
    throw new Error(`compact_replay_${field}_invalid`);
  }
  return text;
}

function textArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 12) {
    throw new Error(`compact_replay_${field}_invalid`);
  }
  return value.map((item) => requiredText(item, field, 500));
}
