import type { RuntimeMessageLanguage } from "../../../output/messages.ts";
import { evidenceReceiptsFromResult } from "../../../output/evidence-receipts.ts";
import type { ToolAuditEntry } from "../output/tool-types.ts";

const GOAL_COMPLETION_REVIEW_SKIP_TOOLS = new Set([
  "dispatch_worker",
  "resume_worker",
  "run_planned_task",
  "repair_planned_task",
  "run_ready_work_streams",
  "write_planned_public_report",
  "write_work_orchestration_report",
]);

export function hasVerifiedEvidenceReceipt(audit: ToolAuditEntry[]): boolean {
  return audit.some((entry) => {
    if (!entry.ok) return false;
    if ((entry.satisfiedCompletionObligations ?? []).includes("source_verified")) return true;
    const receipts = [
      ...(entry.evidenceReceipts ?? []),
      ...evidenceReceiptsFromResult(entry.result),
    ];
    return receipts.some((receipt) => receipt.verified);
  });
}

export function hasPendingReadRequirement(audit: ToolAuditEntry[]): boolean {
  const hasReadRequirement = audit.some((entry) => {
    if (!entry.ok) return false;
    const result = entry.result && typeof entry.result === "object" && !Array.isArray(entry.result)
      ? entry.result as Record<string, unknown>
      : null;
    return result?.read_required === true;
  });
  if (!hasReadRequirement) return false;
  return !audit.some((entry) => entry.ok && entry.name === "web_read");
}

export function finalContractFallbackText(language: RuntimeMessageLanguage): string {
  return language === "ko"
    ? "도구 실행 근거가 확인되지 않아 현재 정보는 검증하지 못했습니다."
    : "I could not verify the result because no completed tool evidence was available.";
}

export function hasGoalCompletionReviewSkipTool(audit: ToolAuditEntry[]): boolean {
  return audit.some((entry) => entry.ok && GOAL_COMPLETION_REVIEW_SKIP_TOOLS.has(entry.name));
}
