import { appCopy } from "@/app/copy.ts";
export function phaseLabel(phase?: string): string {
  if (!phase) return appCopy.interfaceStatus.working;
  if (phase === "delivered" || phase === "completed") return appCopy.interfaceStatus.completed;
  if (phase === "failed" || phase === "runtime_fault") return appCopy.interfaceStatus.failed;
  if (phase === "cancelled") return appCopy.interfaceStatus.stopped;
  if (phase.startsWith("conception")) return appCopy.interfaceStatus.conception;
  if (phase === "contract_review") return appCopy.interfaceStatus.conceptionReview;
  if (phase === "planning") return appCopy.interfaceStatus.planning;
  if (phase === "planning_review") return appCopy.interfaceStatus.planningReview;
  if (phase === "task_execution" || phase === "execution") return appCopy.interfaceStatus.execution;
  if (phase === "task_review" || phase === "review") return appCopy.interfaceStatus.taskReview;
  if (phase === "validation") return appCopy.interfaceStatus.validation;
  if (phase.startsWith("feedback_")) return appCopy.interfaceStatus.feedback;
  if (phase === "consolidation") return appCopy.interfaceStatus.consolidation;
  if (phase === "reporting") return appCopy.interfaceStatus.reporting;
  return appCopy.interfaceStatus.working;
}
