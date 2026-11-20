import { formatInterfaceText, getAppCopy, getInterfaceProgressLabel, type AppCopy, type AppLocale } from "../../../butler-i18n/src/index.ts";
import type { ProgressSummaryRow, SessionViewTurn, StewardChild } from "../../../butler-protocol/src/index.ts";

type Status = { label: string; tone: "accent" | "success" | "danger" | "neutral" };

export function progressRowLabel(row: ProgressSummaryRow, locale: AppLocale): string {
  const reference = row.interface_content?.summary ?? (!row.work_decision_summary ? row.interface_content?.title : undefined);
  if (reference) return formatInterfaceText(reference, locale);
  return getInterfaceProgressLabel(row.interface_label_key, locale, row.interface_label_parameters) ?? getAppCopy(locale).guided.tools[row.safe_label] ?? row.safe_label;
}

export function phaseLabel(phase: string | undefined, copy: AppCopy): string {
  if (!phase) return copy.interfaceStatus.working;
  if (phase === "delivered" || phase === "completed") return copy.interfaceStatus.completed;
  if (phase === "failed" || phase === "runtime_fault") return copy.interfaceStatus.failed;
  if (phase === "cancelled") return copy.interfaceStatus.stopped;
  if (phase.startsWith("conception")) return copy.interfaceStatus.conception;
  if (phase === "contract_review") return copy.interfaceStatus.conceptionReview;
  if (phase === "planning") return copy.interfaceStatus.planning;
  if (phase === "planning_review") return copy.interfaceStatus.planningReview;
  if (phase === "task_execution" || phase === "execution") return copy.interfaceStatus.execution;
  if (phase === "task_review" || phase === "review") return copy.interfaceStatus.taskReview;
  if (phase === "validation") return copy.interfaceStatus.validation;
  if (phase.startsWith("feedback_")) return copy.interfaceStatus.feedback;
  if (phase === "consolidation") return copy.interfaceStatus.consolidation;
  if (phase === "reporting") return copy.interfaceStatus.reporting;
  return copy.interfaceStatus.working;
}

const TERMINAL_STEWARD_STATES = new Set(["delivered", "failed", "cancelled"]);

function effectiveStewardStatus(child: StewardChild): string {
  const status: string = child.status;
  if (status === "completed") return "delivered";
  if (status === "blocked") return "delivered";
  if (TERMINAL_STEWARD_STATES.has(status)) return status;
  if (!child.terminal) return status;
  switch (child.result?.status) {
    case "success":
    case "blocked": return "delivered";
    case "cancelled": return "cancelled";
    case "failed": return "failed";
    default: return "delivered";
  }
}

export function stewardStatus(child: StewardChild, copy: AppCopy): Status {
  const status = effectiveStewardStatus(child);
  if (status === "delivered") return { label: copy.interfaceStatus.delivered, tone: "success" };
  if (status === "failed") return { label: copy.interfaceStatus.failedPast, tone: "danger" };
  if (status === "cancelled") return { label: copy.interfaceStatus.cancelled, tone: "neutral" };
  if (status === "idle") return { label: copy.interfaceStatus.idle, tone: "neutral" };
  const progress = stewardPlanProgress(child);
  return { label: progress ? `${copy.interfaceStatus.working} · ${progress}` : copy.interfaceStatus.working, tone: "accent" };
}

function stewardPlanProgress(child: StewardChild): string | null {
  const total = child.approved_plan_total;
  const completed = child.approved_plan_completed;
  if (total === undefined || completed === undefined || total < 1) return null;
  const boundedCompleted = Math.min(total, Math.max(0, completed));
  return `${Math.min(total, boundedCompleted + 1)}/${total}`;
}

export function turnLatest(turn: SessionViewTurn | null, locale: AppLocale): string | null {
  if (turn?.safe_status_label) {
    return turn.progress?.summary_reference ? formatInterfaceText(turn.progress.summary_reference, locale) : turn.safe_status_label;
  }
  const row = turn?.progress?.safe_progress_rows.at(-1);
  return row ? progressRowLabel(row, locale) : null;
}

export function blockStatus(state: string, copy: AppCopy): Status {
  const tone = state === "delivered" || state === "completed" ? "success"
    : state === "failed" || state === "runtime_fault" ? "danger" : state === "cancelled" ? "neutral" : "accent";
  return { label: phaseLabel(state, copy), tone };
}
