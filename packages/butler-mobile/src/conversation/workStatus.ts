import { commandProgram, uniqueFileTargets, formatInterfaceText, getAppCopy, getInterfaceProgressLabel, type AppCopy, type AppLocale } from "../../../butler-i18n/src/index.ts";
import type { ProgressSummaryRow, SessionViewTurn, StewardChild, WorkerActivityWorkBlock } from "../../../butler-protocol/src/index.ts";

import { projectActivities } from "./activityProjection";

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

export function stewardProgressStatus(child: StewardChild, appCopy: AppCopy): string {
  const status = effectiveStewardStatus(child);
  if (status === "delivered") return appCopy.interfaceStatus.delivered;
  if (status === "failed") return appCopy.interfaceStatus.failedPast;
  if (status === "cancelled") return appCopy.interfaceStatus.cancelled;
  if (status === "idle") return appCopy.interfaceStatus.idle;
  const progress = stewardPlanProgress(child);
  if (progress) return `${appCopy.interfaceStatus.working} · ${progress}`;
  return appCopy.interfaceStatus.working;
}

/** Accepted plans add step detail without changing the legacy card's fallback. */
export function stewardCardStatus(child: StewardChild, narrow: boolean, appCopy: AppCopy): string {
  if (!child.plan) return stewardProgressStatus(child, appCopy);
  const status = effectiveStewardStatus(child);
  const actions = [...child.plan.actions].sort((left, right) => left.order - right.order);
  const copy = appCopy.conversation.work.planSteps;
  const done = actions.filter(action => action.status === "done").length;
  if (status === "delivered") return copy.delivered(done, actions.length);
  if (status === "failed") return copy.failed((actions.find(action => action.status === "blocked") ??
    actions.find(action => action.status === "active"))?.title ?? "");
  if (status === "idle" || status === "cancelled") return stewardProgressStatus(child, appCopy);
  const active = actions.filter(action => action.status === "active");
  if (narrow && active.length >= 2) return copy.compact(active[0]!.title, active.length - 1);
  return copy.running(done, actions.length, active.map(action => action.title).join(", "));
}

export function stewardPlanProgress(child: StewardChild): string | null {
  const total = child.approved_plan_total;
  const completed = child.approved_plan_completed;
  if (total === undefined || completed === undefined || total < 1) return null;
  const boundedCompleted = Math.min(total, Math.max(0, completed));
  return `${Math.min(total, boundedCompleted + 1)}/${total}`;
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

export function visibleRows(rows: ProgressSummaryRow[]): ProgressSummaryRow[] {
  return rows.filter(row => !isInternalProgressRow(row));
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

export function toolGroupLabel(row: ProgressSummaryRow, copy: AppCopy): string {
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
  const latest = projectActivities(rows, undefined, locale).activities.at(-1);
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
  const activities = projectActivities(rows, undefined, locale).activities;
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

export function stewardCurrentActivityTitle(
  child: Pick<StewardChild, "active_turn" | "waiting_for_children">,
  locale: AppLocale,
): string {
  const appCopy = getAppCopy(locale);
  if (child.waiting_for_children && !child.active_turn) {
    return appCopy.conversation.work.pendingStateLabels.waiting_for_children;
  }
  const rows = child.active_turn?.progress?.safe_progress_rows ?? [];
  const activeActivity = latestMatchingRow(rows, (row) =>
    row.kind !== "todo" &&
    row.kind !== "turn" &&
    !isGenericModelRoundActivity(row) &&
    !isModelAuthoredPhaseActivity(row) &&
    (row.state === "running" || row.state === "thinking") &&
    row.safe_label.trim().length > 0,
  );
  const latestActivity = latestMatchingRow(rows, (row) =>
    row.kind !== "todo" &&
    row.kind !== "turn" &&
    !isGenericModelRoundActivity(row) &&
    !isModelAuthoredPhaseActivity(row) &&
    row.safe_label.trim().length > 0,
  );
  const activePlanStep = rows.find((row) =>
    row.kind === "todo" &&
    (row.state === "active" || row.state === "running") &&
    row.safe_label.trim().length > 0,
  );
  const genericActivity = latestMatchingRow(rows, (row) =>
    row.kind !== "todo" &&
    isGenericModelRoundActivity(row) &&
    row.safe_label.trim().length > 0,
  );
  return (
    (activeActivity && progressRowLabel(activeActivity, locale)) ||
    (latestActivity && progressRowLabel(latestActivity, locale)) ||
    (activePlanStep && progressRowLabel(activePlanStep, locale)) ||
    (genericActivity && progressRowLabel(genericActivity, locale)) ||
    (child.active_turn?.progress?.summary_reference ? formatInterfaceText(child.active_turn.progress.summary_reference, locale) : child.active_turn?.progress?.summary ?? "") ||
    appCopy.interfaceStatus.progress
  ).trim().replace(/\s+/gu, " ");
}

function isGenericModelRoundActivity(row: ProgressSummaryRow): boolean {
  return row.bridge_phase === "model_round_waiting" ||
    row.safe_tool_name === "model_round";
}

function isModelAuthoredPhaseActivity(row: ProgressSummaryRow): boolean {
  return row.work_decision_source === "model-authored";
}

function latestMatchingRow(
  rows: ProgressSummaryRow[],
  matches: (row: ProgressSummaryRow) => boolean,
): ProgressSummaryRow | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row && matches(row)) return row;
  }
  return undefined;
}

export function workerActivityTitle(
  currentActivity: string,
  taskTitle: string,
  appCopy: AppCopy,
): string {
  const current = currentActivity.trim();
  if (isUsefulWorkerActivityTitle(current, appCopy)) return current;
  const title = taskTitle.trim();
  return isUsefulWorkerActivityTitle(title, appCopy)
    ? title
    : appCopy.interfaceDetails.workerActivity;
}

function isUsefulWorkerActivityTitle(value: string, appCopy: AppCopy): boolean {
  const normalized = value.trim().toLowerCase();
  const genericLabels = [
    appCopy.interfaceStatus.progress,
    appCopy.guided.tools.fallback,
    appCopy.interfaceDetails.workerActivity,
    "작업 중",
    "도구 사용",
    "도구 사용 내역",
    "tool use",
    "tool usage",
    "use tool",
    "working",
    "native child work",
  ];
  return Boolean(normalized) &&
    !genericLabels.some((label) => normalized === label.trim().toLowerCase()) &&
    !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(normalized);
}

export type ToolIcon = "Rocket" | "FileText" | "Pencil" | "Terminal" | "Wrench" | "Search" | "ListChecks" | "AiChip";
export type ToolItem = {
  id: string; icon: ToolIcon; title: string; summaryLabel: string; details?: string;
  output?: { turnId: string; callId: string; resultId: string; toolName?: string; command?: string };
};

export function toolItems(rows: ProgressSummaryRow[], locale: AppLocale): ToolItem[] {
  const copy = getAppCopy(locale);
  return rows.filter(isWorkActivityToolRow).map((row, index) => ({
    id: row.thinking_title ? `thinking:${row.tool_call_id}` : `${row.id}:${index}`,
    icon: row.thinking_title ? "AiChip" : toolIcon(row),
    title: row.thinking_title ?? toolRowLabel(row, locale),
    summaryLabel: row.thinking_title ? copy.interfaceStatus.thinking : toolGroupLabel(row, copy),
    details: row.thinking_title ? row.thinking_body : row.safe_tool_name === "run_command" && row.safe_input_label
      ? `${copy.interfaceStatus.execution}: ${row.safe_input_label}`
      : row.safe_detail_rows?.map(detail => toolchainDetailLabel(detail, row, copy)).join(" "),
    output: row.turn_id && row.tool_call_id && row.tool_result_id
      ? { turnId: row.turn_id, callId: row.tool_call_id, resultId: row.tool_result_id, toolName: row.safe_tool_name,
        command: row.safe_tool_name === "run_command" ? row.safe_input_label : undefined } : undefined,
  }));
}

export function workBlockToolItems(block: WorkerActivityWorkBlock, turnId: string | undefined, locale: AppLocale): ToolItem[] {
  return toolItems(block.rows.filter(row => isVisibleToolActivity(row, block.label)).map(row => ({ ...row, turn_id: turnId })), locale);
}

export function toolIcon(row: ProgressSummaryRow): ToolIcon {
  if (row.safe_tool_name === "delegate_to_worker") return "Rocket";
  if (row.safe_tool_name === "read_file") return "FileText";
  if (row.safe_tool_name === "edit_file" || row.safe_tool_name === "write_file") {
    return "Pencil";
  }
  if (row.safe_tool_name === "run_command") return "Terminal";
  if (row.bridge_phase === "btcc_operation") return "Wrench";
  const label = row.safe_label.toLowerCase();
  if (row.kind === "searched" || label.includes("search")) {
    return "Search";
  }
  if (row.kind === "read" || label.includes("read")) {
    return "FileText";
  }
  if (row.kind === "ran_command") return "Terminal";
  if (row.kind === "edited") return "Pencil";
  if (row.kind === "dispatch") return "Rocket";
  if (row.kind === "used_tool") return "Wrench";
  return "ListChecks";
}

const WORK_BOOKKEEPING_TOOL_NAMES = new Set([
  "start_work",
  "continue_work",
  "replace_work_plan",
  "record_work_checkpoint",
  "record_work_review",
  "record_work_disposition",
  "plan_review",
  "completion_review",
  "work_tool",
  "tool_work",
]);

/** A row the activity timeline lists as a tool (work bookkeeping stays out). */
export function isWorkActivityToolRow(row: ProgressSummaryRow): boolean {
  return !(
    ["work", "work_block", "plan", "checkpoint", "disposition"].includes(row.kind?.toLowerCase() ?? "") ||
    (row.safe_tool_name && WORK_BOOKKEEPING_TOOL_NAMES.has(row.safe_tool_name))
  );
}

export function toolchainDetailLabel(
  detail: NonNullable<ProgressSummaryRow["safe_detail_rows"]>[number],
  row: ProgressSummaryRow,
  appCopy: AppCopy,
): string {
  const value = detail.safe_value?.trim();
  const label =
    row.kind === "todo" && detail.safe_label.trim().toLowerCase() === "phase"
      ? appCopy.interfaceStatus.phase
      : (detail.kind?.startsWith("argument_") ? appCopy.guided.argumentLabels[detail.kind.slice(9)] ?? detail.safe_label : detail.safe_label);
  if (!value) return label;
  if (row.safe_tool_name === "Web search")
    return appCopy.conversation.work.webSearchDetail(value);
  return appCopy.conversation.work.detailRow(label, value);
}


// Port of desktop app/conversation-progress/terminal-activity.ts:80-98.
const TOOL_ACTIVITY_KINDS = new Set(["searched", "read", "ran_command", "edited", "dispatch", "used_tool"]);

export function isVisibleToolActivity(
  row: ProgressSummaryRow,
  blockLabel: string,
): boolean {
  const label = row.safe_label.trim();
  const block = blockLabel.trim();
  const toolName = row.safe_tool_name?.trim();
  if (isInternalProgressRow(row) || row.kind === "todo" || row.kind === "message")
    return false;
  if (label && label === block && !row.tool_call_id && !row.safe_input_label) return false;
  if (
    toolName && toolName === block && !row.tool_call_id &&
    !row.safe_input_label && !row.safe_detail_rows?.length
  ) return false;
  return Boolean(
    row.tool_call_id || row.safe_input_label || row.safe_detail_rows?.length ||
    TOOL_ACTIVITY_KINDS.has(row.kind ?? ""),
  );
}
