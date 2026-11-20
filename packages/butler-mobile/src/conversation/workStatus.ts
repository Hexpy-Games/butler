import { commandProgram, uniqueFileTargets, formatInterfaceText, getAppCopy, getInterfaceProgressLabel, type AppCopy, type AppLocale } from "../../../butler-i18n/src/index.ts";
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

export function effectiveStewardStatus(child: StewardChild): string {
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

export function blockStatus(state: string, copy: AppCopy): Status {
  const tone = state === "delivered" || state === "completed" ? "success"
    : state === "failed" || state === "runtime_fault" ? "danger" : state === "cancelled" ? "neutral" : "accent";
  return { label: phaseLabel(state, copy), tone };
}

const INTERNAL_TOOL_NAMES = new Set([
  "Update Todo List",
  "List Todo List",
  "Model preparation",
  "모델 준비",
]);
const INTERNAL_RAW_TOOL_NAMES = new Set([
  "update_todo_list",
  "list_todo_list",
  "model_preparation",
  "start_work",
  "continue_work",
  "replace_work_plan",
  "record_work_checkpoint",
  "record_work_review",
  "record_work_disposition",
]);

export function isInternalProgressRow(row: ProgressSummaryRow): boolean {
  return (
    isInternalToolName(row.safe_tool_name) ||
    isInternalToolName(row.safe_label) ||
    isInternalToolName(row.safe_input_label)
  );
}

function isInternalToolName(value?: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  const normalized = trimmed.toLocaleLowerCase("en-US").replace(/\s+/gu, "_");
  return INTERNAL_TOOL_NAMES.has(trimmed) || INTERNAL_RAW_TOOL_NAMES.has(normalized);
}

function visibleRows(rows: ProgressSummaryRow[]): ProgressSummaryRow[] {
  return rows.filter(row => !isInternalProgressRow(row));
}

export function phaseActivities(rows: ProgressSummaryRow[], locale: AppLocale): { title: string; summary: string; phase?: string }[] {
  return visibleRows(rows).filter(isPhaseActivityRow).map(row => ({
    title: row.interface_content?.title ? formatInterfaceText(row.interface_content.title, locale) : row.work_decision_title ?? row.work_decision_summary,
    summary: row.interface_content?.summary ? formatInterfaceText(row.interface_content.summary, locale) : row.work_decision_summary,
    phase: row.activity_stage,
  }));
}

function isPhaseActivityRow(row: ProgressSummaryRow): row is ProgressSummaryRow & {
  semantic_block_id: string;
  work_decision_summary: string;
} {
  return row.kind === "message" && !row.work_block_id &&
    Boolean(row.semantic_block_id) &&
    row.work_decision_source === "model-authored" &&
    Boolean(row.work_decision_summary);
}

function publicOperationTitle(capabilityRef: string | undefined, copy: AppCopy): string {
  const name = capabilityRef?.trim() ?? "";
  return copy.progress.operations[name] ?? copy.guided.tools[name] ?? copy.progress.fallback;
}

function publicToolLabel(row: ProgressSummaryRow, copy: AppCopy): string {
  const name = row.safe_tool_name ?? "";
  if (["Bun", "Bash", "Web search", "Read", "Edit", "Write"].includes(name)) return name;
  return copy.guided.tools[name] ?? copy.guided.tools.fallback;
}

function toolchainLabel(row: ProgressSummaryRow, locale: AppLocale): string {
  const copy = getAppCopy(locale);
  if (row.safe_tool_name === "ask_user") return publicOperationTitle("ask_user", copy);
  if (row.safe_tool_name && row.safe_input_label) {
    const target = row.safe_tool_name === "run_command" ? commandProgram(row.safe_input_label)
      : ["read_file", "write_file", "edit_file"].includes(row.safe_tool_name)
        ? uniqueFileTargets(row.safe_input_label) : row.safe_input_label;
    return `${publicToolLabel(row, copy)}: ${target}`;
  }
  return row.safe_tool_name
    ? publicToolLabel(row, copy)
    : row.safe_input_label ?? copy.interfaceDetails.tool;
}

export function toolRowLabel(row: ProgressSummaryRow, locale: AppLocale): string {
  const copy = getAppCopy(locale);
  if (row.safe_tool_name === "ask_user") return publicOperationTitle("ask_user", copy);
  if (row.safe_tool_name === "delegate_to_worker") return copy.interfaceStatus.workerCall;
  if (row.bridge_phase === "btcc_operation") {
    if (row.safe_input_label) return toolchainLabel(row, locale);
    const label = progressRowLabel(row, locale);
    const name = row.safe_tool_name ?? "";
    const knownTitle = ["en-US", "ko-KR"] as const;
    if (knownTitle.some(locale => [getAppCopy(locale).guided.tools[name], publicOperationTitle(name, getAppCopy(locale)), getAppCopy(locale).guided.tools.fallback, getAppCopy(locale).progress.fallback].includes(label))) {
      return publicToolLabel(row, copy);
    }
    return label && ![row.safe_tool_name, copy.guided.tools.fallback, copy.progress.fallback].includes(label)
      ? label : toolchainLabel(row, locale);
  }
  return toolchainLabel(row, locale);
}

function toolGroupLabel(row: ProgressSummaryRow, copy: AppCopy): string {
  if (row.safe_tool_name === "ask_user") return publicOperationTitle("ask_user", copy);
  if (row.safe_tool_name === "delegate_to_worker") return copy.interfaceStatus.workerCall;
  if (row.bridge_phase === "btcc_operation") {
    if (row.safe_tool_name === "web_search") return copy.interfaceStatus.search;
    if (
      row.safe_tool_name === "web_read" ||
      row.safe_tool_name === "browser_read" ||
      row.safe_tool_name === "read_file" ||
      row.safe_tool_name === "list_files" ||
      row.safe_tool_name === "grep_files"
    ) {
      return copy.interfaceStatus.lookup;
    }
    if (row.safe_tool_name === "edit_file" || row.safe_tool_name === "write_file") {
      return copy.interfaceStatus.edit;
    }
    if (row.safe_tool_name === "run_command") return copy.interfaceStatus.command;
    return publicToolLabel(row, copy);
  }
  const toolName = row.safe_tool_name?.trim();
  if (
    row.kind === "searched" ||
    toolName === "Web search"
  ) {
    return copy.interfaceStatus.search;
  }
  if (toolName === "Bash") return "Bash";
  if (row.kind === "ran_command") return copy.interfaceStatus.command;
  if (row.kind === "read") return copy.interfaceStatus.read;
  if (row.kind === "edited") return copy.interfaceStatus.edit;
  if (toolName) return publicToolLabel(row, copy);
  if (row.kind === "dispatch") return copy.guided.tools.fallback;
  return copy.interfaceStatus.review;
}

export function latestStatus(rows: ProgressSummaryRow[], live: boolean, settledState: string, locale: AppLocale): string | null {
  const latest = phaseActivities(rows, locale).at(-1);
  if (!latest) return null;
  const copy = getAppCopy(locale);
  const visible = visibleRows(rows);
  const step = visible.slice(visible.findLastIndex(isPhaseActivityRow) + 1).findLast(row => row.bridge_phase === "btcc_operation");
  const kind = live
    ? step ? toolGroupLabel(step, copy) : phaseLabel(latest.phase, copy)
    : phaseLabel(settledState, copy);
  return [latest.title, kind].filter(Boolean).join(" · ");
}

export function turnStatusLabel(turn: SessionViewTurn, locale: AppLocale): string {
  const copy = getAppCopy(locale);
  const rows = visibleRows(turn.progress?.safe_progress_rows ?? []);
  const activities = phaseActivities(rows, locale);
  const operation = rows.findLast(row => row.bridge_phase === "btcc_operation" && row.state === "running");
  if (operation) return toolRowLabel(operation, locale);
  if (currentModelRoundWait(rows)) return copy.interfaceStatus.generating;
  const publicActivity = latestPublicActivity(rows, activities.length > 0);
  if (publicActivity) return progressRowLabel(publicActivity, locale);
  const summary = activities.at(-1)?.summary;
  if (summary) return summary;
  if (rows.length === 0) return copy.conversation.work.pendingStateLabels[turn.state] ?? copy.conversation.work.pendingLabel;
  return copy.interfaceStatus.generating;
}

function currentModelRoundWait(rows: ProgressSummaryRow[]): ProgressSummaryRow | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    if (["failed", "cancelled", "delivered", "complete", "completed", "stopped"].includes(row.state)) return undefined;
    if (row.bridge_phase === "model_round_waiting") return row;
    if (row.work_decision_source === "model-authored" || row.bridge_phase === "operational_recovery")
      return undefined;
  }
  return undefined;
}

function latestPublicActivity(rows: ProgressSummaryRow[], hasModelActivity: boolean): ProgressSummaryRow | undefined {
  return rows.findLast((row) => {
    if (row.kind !== "message" || row.state !== "running" || row.work_block_id) return false;
    if (row.bridge_phase === "model_round_waiting" || row.work_decision_source) return false;
    if (hasModelActivity && row.bridge_phase !== "operational_recovery") return false;
    return row.safe_label.trim().length > 0;
  });
}
