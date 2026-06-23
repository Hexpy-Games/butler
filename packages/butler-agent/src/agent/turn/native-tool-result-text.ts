import type { RuntimeMessageLanguage } from "../output/messages.ts";

export function taskIdFromToolResult(result: unknown): string | null {
  const output = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return typeof output.task_id === "string"
    ? output.task_id
    : typeof output.taskId === "string"
      ? output.taskId
      : null;
}

export function publicReportFromToolOutput(output: unknown): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const report = (output as Record<string, unknown>).report;
  return typeof report === "string" && report.trim() ? report.trim() : null;
}

export function plannedReviewTerminalToolText(input: {
  name: string;
  output: unknown;
  language: RuntimeMessageLanguage;
}): string | null {
  if (!input.output || typeof input.output !== "object" || Array.isArray(input.output)) return null;
  const output = input.output as Record<string, unknown>;
  if (input.name === "repair_planned_task") {
    if (output.ok === false && output.status === "FAILED_PUBLIC_REPORT_READY") {
      return input.language === "ko"
        ? "계획 작업은 더 진행할 수 없어 실패 보고가 준비되었습니다."
        : "The planned task cannot continue, so a failure report is ready.";
    }
    if (output.ok !== false && typeof output.worker_task_id === "string" && output.worker_task_id.trim()) {
      return input.language === "ko"
        ? "수리 작업을 시작했습니다. 완료되면 다시 검토 후 보고하겠습니다."
        : "I started the repair attempt. I will review it again before reporting.";
    }
  }
  if (input.name === "request_principal_decision" && output.status === "BLOCKED_WAITING_PRINCIPAL") {
    return input.language === "ko"
      ? "결정이 필요한 지점에서 작업을 멈추고 사용자 결정을 기다립니다."
      : "The work is paused at a required principal decision.";
  }
  return null;
}
