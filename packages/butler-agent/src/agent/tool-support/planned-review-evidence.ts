import { reviewCapabilityReceipt } from "../output/evidence/ledger.ts";
import type { PlannedReviewVerdict } from "../work/planned-task.ts";

export function stalePlannedReviewCapabilityReceipts(input: {
  taskId: string;
  reason: string;
}) {
  return [reviewCapabilityReceipt({
    producer: { kind: "runtime", name: "review_planned_task" },
    result: "skipped",
    outcome: input.reason,
    references: [{ task_id: input.taskId }],
    limitations: ["Stale planned review events are ignored instead of mutating task state."],
  })];
}

export function plannedReviewCapabilityReceipts(input: {
  taskId: string;
  verdict: PlannedReviewVerdict;
  missingEvidence: string[];
  repairRecommendation: string | null;
}) {
  return [reviewCapabilityReceipt({
    producer: { kind: "tool", name: "review_planned_task" },
    result: input.verdict === "PASS"
      ? "completed"
      : input.verdict === "FAIL"
        ? "changes_requested"
        : "partial",
    outcome: input.verdict === "PASS"
      ? "Planned task review passed."
      : input.repairRecommendation ?? "Planned task review did not pass.",
    references: [{ task_id: input.taskId }],
    limitations: input.missingEvidence,
  })];
}
