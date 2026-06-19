import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { writeLockedTextFile } from "./file-state.ts";
import {
  readTaskOrigin,
  resolveTaskOriginContext,
  writeTaskOrigin,
  type ResolvedTaskOriginContext,
  type TaskOriginContext,
} from "./task-origin.ts";
import {
  plannedModeSafety,
  readPlannedTaskRecord,
  type PlannedTaskRecord,
  type PlannedTaskStatus,
  type PlannedReviewVerdict,
} from "./planned-task.ts";
import {
  summarizeWorkerCompletionEvidence,
  type WorkerCompletionEvidenceSummary,
} from "./worker-evidence.ts";

export type TaskStatus =
  | "APPROVED"
  | "RUNNING"
  | "DONE"
  | "FAILED"
  | "RECOVERABLE"
  | "REVIEWED"
  | "KILLED"
  | "UNKNOWN";

export type WorkMode =
  | "planning"
  | "inspecting"
  | "executing"
  | "reviewing"
  | "repairing"
  | "blocked"
  | "reporting"
  | "complete"
  | "cancelled"
  | "failed";

export type WorkerActivityPhaseName =
  | "orienting"
  | "planning"
  | "inspecting"
  | "executing"
  | "verifying"
  | "committing"
  | "consolidating"
  | "reporting"
  | "complete"
  | "blocked"
  | "failed"
  | "cancelled"
  | "recoverable";

export interface TaskRecord {
  taskId: string;
  taskDir: string;
  status: TaskStatus;
  project: string | null;
  request: string | null;
  result: string | null;
  observedResult: string | null;
  logTail: string | null;
  hasResult: boolean;
  notifiedAt: string | null;
  origin: TaskOriginContext | null;
  planned: PlannedTaskRecord | null;
  completionEvidence: WorkerCompletionEvidenceSummary;
}

export interface TaskSummary {
  task_id: string;
  task_type: "direct" | "planned";
  status: TaskStatus;
  project: string | null;
  origin_session_id: string | null;
  origin_project: string | null;
  request: string | null;
  has_result: boolean;
  has_log: boolean;
  observed_result_preview: string | null;
  origin_summary: string | null;
  planned_status: PlannedTaskStatus | null;
  planned_goal: string | null;
  review_verdict: PlannedReviewVerdict | null;
  public_report_ready: boolean;
  work_mode: WorkMode;
  safe_to_report: boolean;
  completion_claim_allowed: boolean;
  guard_reason: string | null;
  can_resume: boolean;
  user_summary: string;
  next_step: string;
  activity_phase: WorkerActivityPhaseName | null;
  activity_semantic_phase: WorkerActivityPhaseName | null;
  activity_action_kind: string | null;
  activity_status_line: string | null;
  activity_current_title: string | null;
  activity_work_blocks: WorkerActivityWorkBlock[];
  activity_updated_at: string | null;
  completion_evidence: WorkerCompletionEvidenceSummary;
  updated_at: string | null;
}

export interface WorkerActivityProgressDetailRow {
  id: string;
  kind?: string;
  safe_label: string;
  safe_value?: string;
  state?: string;
}

export interface WorkerActivityProgressRow {
  id: string;
  kind: string;
  safe_label: string;
  state: string;
  safe_tool_name?: string;
  safe_input_label?: string;
  tool_call_id?: string;
  work_block_id?: string;
  work_block_label?: string;
  work_decision_summary?: string;
  work_decision_rationale?: string;
  work_decision_next_step?: string;
  work_decision_source?: string;
  work_decision_evidence_refs?: string[];
  safe_detail_rows?: WorkerActivityProgressDetailRow[];
  created_at: string;
}

export interface WorkerActivityWorkBlock {
  id: string;
  label: string;
  state: string;
  rows: WorkerActivityProgressRow[];
  decision_summary?: string;
  decision_rationale?: string;
  decision_next_step?: string;
  decision_source?: string;
  decision_evidence_refs?: string[];
  created_at?: string;
}

export interface TaskRecoveryReconcileResult {
  task_id: string;
  from: TaskStatus;
  to: TaskStatus;
  reason: string;
}

const NOTIFIED_MARKER = ".worker-result-notified";
const LEGACY_NOTIFIED_MARKER = ".telegram-notified";

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function writeText(path: string, value: string): void {
  writeLockedTextFile(path, value);
}

function normalizeStatus(value: string): TaskStatus {
  if (
    value === "APPROVED" ||
    value === "RUNNING" ||
    value === "DONE" ||
    value === "FAILED" ||
    value === "RECOVERABLE" ||
    value === "REVIEWED" ||
    value === "KILLED"
  ) {
    return value;
  }
  return "UNKNOWN";
}

function tailText(value: string, limit: number): string {
  return value.length > limit ? value.slice(-limit) : value;
}

function compactOneLine(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function taskSubject(task: TaskRecord): string {
  return compactOneLine(
    task.origin?.task_summary ||
      task.planned?.plan.goal ||
      task.request ||
      `worker task ${task.taskId}`,
    160,
  );
}

function taskUserSummary(task: TaskRecord): string {
  const subject = taskSubject(task);
  if (task.planned) {
    const status = task.planned.status;
    if (status === "PUBLIC_REPORT_READY" || status === "FAILED_PUBLIC_REPORT_READY") {
      return `${subject}: reviewed report is ready for delivery.`;
    }
    if (status === "REVIEW_PASSED") return `${subject}: review passed; final report is being prepared.`;
    if (status === "REVIEW_FAILED" || status === "REVIEW_INCONCLUSIVE") {
      return `${subject}: review found gaps; repair or partial reporting is needed.`;
    }
    if (status === "PLANNED_RUNNING" || status === "REPAIRING" || status === "REVIEWING") {
      return `${subject}: planned work is still in progress.`;
    }
    if (status === "BLOCKED_WAITING_PRINCIPAL") return `${subject}: waiting for your decision.`;
    return `${subject}: planned work status is ${status}.`;
  }

  if (task.status === "RUNNING") return `${subject}: worker is still running.`;
  if (task.status === "RECOVERABLE") return `${subject}: worker was interrupted and can be resumed.`;
  if (task.status === "DONE" || task.status === "REVIEWED") return `${subject}: worker completed.`;
  if (task.status === "FAILED") return `${subject}: worker failed; available logs/results can be reviewed.`;
  if (task.status === "KILLED") return `${subject}: worker was stopped.`;
  return `${subject}: worker status is ${task.status}.`;
}

function taskNextStep(task: TaskRecord): string {
  if (task.status === "RECOVERABLE") return "Resume the worker if the principal asks to continue.";
  if (task.status === "RUNNING") return "Report that the worker is still running; do not claim completion.";
  if (task.planned?.status === "PUBLIC_REPORT_READY" || task.planned?.status === "FAILED_PUBLIC_REPORT_READY") {
    return "Deliver the reviewed public report through the notification queue.";
  }
  if (task.planned?.status === "REVIEW_FAILED" || task.planned?.status === "REVIEW_INCONCLUSIVE") {
    return "Run the planned repair flow if the repair policy allows it.";
  }
  if (task.status === "FAILED") return "Summarize the failure from durable result/log evidence.";
  return "Answer from durable task state and avoid exposing internal ids unless asked.";
}

function directModeSafety(
  status: TaskStatus,
  evidence: WorkerCompletionEvidenceSummary,
): {
  work_mode: WorkMode;
  safe_to_report: boolean;
  completion_claim_allowed: boolean;
  guard_reason: string | null;
} {
  if (status === "APPROVED" || status === "RUNNING") {
    return {
      work_mode: "executing",
      safe_to_report: false,
      completion_claim_allowed: false,
      guard_reason: "Worker is still running; do not claim completion.",
    };
  }
  if (status === "RECOVERABLE") {
    return {
      work_mode: "repairing",
      safe_to_report: false,
      completion_claim_allowed: false,
      guard_reason: "Worker was interrupted and should be resumed before reporting completion.",
    };
  }
  if (status === "DONE" || status === "REVIEWED") {
    if (!evidence.safe_to_report) {
      return {
        work_mode: "reviewing",
        safe_to_report: false,
        completion_claim_allowed: false,
        guard_reason: evidence.guard_reason ?? "Worker completion evidence is insufficient.",
      };
    }
    return {
      work_mode: "complete",
      safe_to_report: true,
      completion_claim_allowed: evidence.completion_claim_allowed,
      guard_reason: evidence.guard_reason,
    };
  }
  if (status === "KILLED") {
    return {
      work_mode: "cancelled",
      safe_to_report: false,
      completion_claim_allowed: false,
      guard_reason: "Worker was stopped before completion.",
    };
  }
  return {
    work_mode: "failed",
    safe_to_report: status === "FAILED",
    completion_claim_allowed: false,
    guard_reason: status === "FAILED"
      ? "Only a failure report is safe; do not claim completion."
      : "Worker state is unknown; inspect durable evidence before reporting.",
  };
}

export function workSafetyForTask(task: TaskRecord): {
  work_mode: WorkMode;
  safe_to_report: boolean;
  completion_claim_allowed: boolean;
  guard_reason: string | null;
} {
  if (!task.planned) return directModeSafety(task.status, task.completionEvidence);
  return plannedModeSafety(task.planned);
}

function extractCommandBlocks(log: string): Array<{
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const blocks: Array<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  }> = [];
  const lines = log.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const commandMatch = lines[index]?.match(/run_shell \((.*?)\):/);
    if (!commandMatch) continue;
    let exitCode: number | null = null;
    let stdout = "";
    let stderr = "";

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (line.includes("run_shell (")) break;
      const resultMatch = line.match(/run_shell result: exit=(-?\d+|null)/);
      if (resultMatch) {
        exitCode = resultMatch[1] === "null" ? -1 : Number(resultMatch[1]);
        continue;
      }
      if (line.includes(" stdout:")) {
        const next: string[] = [];
        for (let body = cursor + 1; body < lines.length; body += 1) {
          const bodyLine = lines[body] ?? "";
          if (bodyLine.startsWith("[worker-runner]")) break;
          next.push(bodyLine);
        }
        stdout = next.join("\n").trim();
        continue;
      }
      if (line.includes(" stderr:")) {
        const next: string[] = [];
        for (let body = cursor + 1; body < lines.length; body += 1) {
          const bodyLine = lines[body] ?? "";
          if (bodyLine.startsWith("[worker-runner]")) break;
          next.push(bodyLine);
        }
        stderr = next.join("\n").trim();
      }
    }

    if (exitCode !== null) {
      blocks.push({
        command: commandMatch[1] ?? "command",
        exitCode,
        stdout,
        stderr,
      });
    }
  }

  return blocks;
}

function internalNonZeroExits(stdout: string): string[] {
  const failures: string[] = [];
  let currentCommand = "";
  for (const line of stdout.split(/\r?\n/)) {
    const commandMatch = line.match(/^===== COMMAND: (.+) =====$/);
    if (commandMatch) {
      currentCommand = commandMatch[1] ?? "";
      continue;
    }
    const exitMatch = line.match(/^===== EXIT: (-?\d+) =====$/);
    if (!exitMatch) continue;
    const exitCode = Number(exitMatch[1]);
    if (exitCode !== 0) {
      failures.push(`${currentCommand || "subcommand"}: exit ${exitCode}`);
    }
  }
  return failures;
}

export function summarizeWorkerLog(log: string): string | null {
  const blocks = extractCommandBlocks(log);
  if (blocks.length === 0) return null;

  const lines = ["Observed worker execution from log.txt:"];
  const aggregate = blocks.find((block) =>
    /aggregate validation|bun run check|declared aggregate/.test(block.command) ||
    /bun run check/.test(block.stdout) ||
    /PASS: native purge gate/.test(block.stdout),
  );
  if (aggregate) {
    lines.push(`- Root validation: ${aggregate.exitCode === 0 ? "passed" : `failed (exit ${aggregate.exitCode})`}.`);
    const signal = [
      aggregate.stdout.includes("PASS: managed bun runtime") ? "managed bun runtime passed" : "",
      aggregate.stdout.includes("PASS: native purge gate") ? "native purge gate passed" : "",
      aggregate.stderr.includes("0 fail") ? "unit tests reported 0 failures" : "",
    ].filter(Boolean);
    if (signal.length > 0) lines.push(`- Root validation signals: ${signal.join(", ")}.`);
  }

  const successful = blocks.filter((block) => block.exitCode === 0);
  if (successful.length > 0) {
    lines.push("- Partial successful command(s) before completion/failure:");
    for (const success of successful.slice(-4)) {
      lines.push(`  - ${compactOneLine(success.command, 180)}: exit 0`);
      const evidence = compactOneLine(success.stdout || success.stderr, 500);
      if (evidence) lines.push(`    observed: ${evidence}`);
    }
  }

  const failures = blocks.filter((block) => block.exitCode !== 0);
  const internalFailures = blocks.flatMap((block) => internalNonZeroExits(block.stdout));
  if (failures.length > 0) {
    lines.push("- Later non-zero command(s):");
    for (const failure of failures.slice(-3)) {
      lines.push(`  - ${failure.command}: exit ${failure.exitCode}`);
      const detail = tailText([failure.stderr, failure.stdout].filter(Boolean).join("\n"), 700).trim();
      if (detail) lines.push(`    ${detail.replace(/\n/g, "\n    ")}`);
    }
  }
  if (internalFailures.length > 0) {
    lines.push("- Non-zero subcommand(s) observed inside grouped shell command:");
    for (const failure of internalFailures.slice(-5)) {
      lines.push(`  - ${failure}`);
    }
  }

  const terminalErrors = log.split(/\r?\n/)
    .filter((line) => /\[worker-runner\].*ERROR:/.test(line))
    .slice(-3);
  if (terminalErrors.length > 0) {
    lines.push("- Worker terminal error(s):");
    for (const error of terminalErrors) {
      lines.push(`  - ${error.replace(/^\[worker-runner\]\s*/, "")}`);
    }
  }

  if (!aggregate && failures.length === 0 && internalFailures.length === 0 && terminalErrors.length === 0) {
    const last = blocks.at(-1);
    if (last) lines.push(`- Last command "${last.command}" exited ${last.exitCode}.`);
  }

  return lines.join("\n");
}

function isGenericResult(result: string | null): boolean {
  return Boolean(result && /^EXIT_CODE:\s*-?\d+\s*$/i.test(result.trim()));
}

function normalizeWorkerActivityPhase(value: unknown): WorkerActivityPhaseName | null {
  if (
    value === "orienting" ||
    value === "planning" ||
    value === "inspecting" ||
    value === "executing" ||
    value === "verifying" ||
    value === "committing" ||
    value === "consolidating" ||
    value === "reporting" ||
    value === "complete" ||
    value === "blocked" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "recoverable"
  ) {
    return value;
  }
  return null;
}

function readWorkerActivityProjection(taskDir: string): {
  phase: WorkerActivityPhaseName | null;
  status_line: string | null;
  current_title: string | null;
  semantic_phase: WorkerActivityPhaseName | null;
  action_kind: string | null;
  work_blocks: WorkerActivityWorkBlock[];
  updated_at: string | null;
} {
  const raw = readText(join(taskDir, "worker_activity.json"));
  const timelineWorkBlocks = readWorkerTimelineWorkBlocks(taskDir);
  if (!raw) return { phase: null, status_line: null, current_title: null, semantic_phase: null, action_kind: null, work_blocks: timelineWorkBlocks, updated_at: null };
  try {
    const parsed = JSON.parse(raw) as {
      phase?: unknown;
      status_line?: unknown;
      current_title?: unknown;
      semantic_phase?: unknown;
      action_kind?: unknown;
      work_blocks?: unknown;
      updated_at?: unknown;
    };
    return {
      phase: normalizeWorkerActivityPhase(parsed.phase),
      status_line: typeof parsed.status_line === "string" ? compactOneLine(parsed.status_line, 180) : null,
      current_title: typeof parsed.current_title === "string" ? compactOneLine(parsed.current_title, 180) : null,
      semantic_phase: normalizeWorkerActivityPhase(parsed.semantic_phase),
      action_kind: typeof parsed.action_kind === "string" ? compactOneLine(parsed.action_kind, 80) : null,
      work_blocks: mergeWorkerActivityWorkBlocks(
        safeWorkerActivityWorkBlocks(parsed.work_blocks),
        timelineWorkBlocks,
      ),
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : null,
    };
  } catch {
    return { phase: null, status_line: null, current_title: null, semantic_phase: null, action_kind: null, work_blocks: timelineWorkBlocks, updated_at: null };
  }
}

function mergeWorkerActivityWorkBlocks(
  primary: WorkerActivityWorkBlock[],
  timeline: WorkerActivityWorkBlock[],
): WorkerActivityWorkBlock[] {
  const blocks = new Map<string, WorkerActivityWorkBlock>();
  for (const block of [...primary, ...timeline]) {
    const current = blocks.get(block.id);
    if (!current) {
      blocks.set(block.id, { ...block, rows: [...block.rows] });
      continue;
    }
    blocks.set(block.id, {
      ...current,
      state: mergeActivityState(current.state, block.state),
      rows: mergeWorkerActivityRows(current.rows, block.rows),
      decision_summary: current.decision_summary ?? block.decision_summary,
      decision_rationale: current.decision_rationale ?? block.decision_rationale,
      decision_next_step: current.decision_next_step ?? block.decision_next_step,
      decision_source: current.decision_source ?? block.decision_source,
      decision_evidence_refs: current.decision_evidence_refs ?? block.decision_evidence_refs,
      created_at: current.created_at ?? block.created_at,
    });
  }
  return [...blocks.values()].slice(-25);
}

function mergeWorkerActivityRows(
  primary: WorkerActivityProgressRow[],
  timeline: WorkerActivityProgressRow[],
): WorkerActivityProgressRow[] {
  const rows = new Map<string, WorkerActivityProgressRow>();
  for (const row of [...primary, ...timeline]) rows.set(row.id, row);
  return [...rows.values()].slice(-40);
}

function mergeActivityState(left: string, right: string): string {
  if (left === "failed" || right === "failed") return "failed";
  if (right === "running") return "running";
  if (right === "delivered" || right === "complete") return "delivered";
  if (left === "running") return "running";
  if (left === "delivered" || left === "complete") return "delivered";
  return right || left || "running";
}

function readWorkerTimelineWorkBlocks(taskDir: string): WorkerActivityWorkBlock[] {
  const rows: WorkerActivityProgressRow[] = [
    ...workerActivityRowsFromEvents(taskDir),
    ...workerActivityRowsFromTranscript(taskDir),
  ];
  if (rows.length === 0) return [];
  const blocks = new Map<string, WorkerActivityWorkBlock>();
  for (const row of rows) {
    const blockId = row.work_block_id ?? row.tool_call_id ?? `worker-timeline-${row.id}`;
    const blockLabel = row.work_block_label ?? row.safe_label;
    const current = blocks.get(blockId);
    if (current) {
      current.rows.push(row);
      current.state = mergeActivityState(current.state, row.state);
      continue;
    }
    blocks.set(blockId, {
      id: blockId,
      label: blockLabel,
      state: row.state,
      rows: [row],
      decision_summary: row.work_decision_summary,
      decision_rationale: row.work_decision_rationale,
      decision_next_step: row.work_decision_next_step,
      decision_source: row.work_decision_source,
      decision_evidence_refs: row.work_decision_evidence_refs,
      created_at: row.created_at,
    });
  }
  return [...blocks.values()].slice(-25);
}

function workerActivityRowsFromEvents(taskDir: string): WorkerActivityProgressRow[] {
  return readJsonlRecords(join(taskDir, "worker_activity_events.jsonl"))
    .map((event, index) => rowFromWorkerActivityEvent(event, index))
    .filter((row): row is WorkerActivityProgressRow => Boolean(row))
    .slice(-40);
}

function rowFromWorkerActivityEvent(
  event: Record<string, unknown>,
  index: number,
): WorkerActivityProgressRow | null {
  const eventName = safeActivityText(event.event, 80);
  if (
    eventName !== "activity_updated" &&
    eventName !== "public_work_decision" &&
    eventName !== "tool_call" &&
    eventName !== "tool_result" &&
    eventName !== "evidence_receipt"
  ) {
    return null;
  }
  const createdAt = typeof event.created_at === "string" ? event.created_at : new Date(0).toISOString();
  const actionKind = safeTimelineKind(event.action_kind ?? eventName);
  const title = safeTimelineText(event.current_title, 180) ??
    safeTimelineText(event.decision_summary, 180) ??
    safeTimelineText(event.status_line, 180) ??
    workerTimelineFallbackLabel(actionKind);
  const statusLine = safeTimelineText(event.status_line, 220);
  const workBlockId = safeActivityToken(event.work_block_id) ?? `worker-timeline-${index + 1}`;
  const row: WorkerActivityProgressRow = {
    id: safeActivityToken(event.event_id) ?? `${workBlockId}-row-${index + 1}`,
    kind: actionKind,
    safe_label: title,
    state: workerTimelineState(eventName, event),
    safe_tool_name: eventName === "public_work_decision" ? "Decision" : "Worker timeline",
    ...(statusLine ? { safe_input_label: statusLine } : {}),
    work_block_id: workBlockId,
    work_block_label: title,
    ...workerDecisionFieldsFromRecord(event),
    created_at: createdAt,
  };
  return row;
}

function workerActivityRowsFromTranscript(taskDir: string): WorkerActivityProgressRow[] {
  const sessionId = readText(join(taskDir, "session_id")).trim();
  if (!sessionId) return [];
  const butlerData = join(taskDir, "..", "..");
  const transcriptPath = join(butlerData, "transcripts", `${sanitizeWorkerTranscriptId(`worker/${sessionId}`)}.jsonl`);
  const rows: WorkerActivityProgressRow[] = [];
  const toolDecisions = new Map<string, Record<string, unknown>>();
  let lastDecision: Record<string, unknown> | null = null;
  for (const [index, event] of readJsonlRecords(transcriptPath).entries()) {
    const row = rowFromWorkerTranscriptEvent(event, index, lastDecision, toolDecisions);
    if (!row) continue;
    rows.push(row);
    if (row.kind === "decision") {
      const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
      lastDecision = transcriptDecisionFromPayload(payload) ?? payload;
      continue;
    }
    const toolCallId = row.tool_call_id;
    if (toolCallId && lastDecision && event.kind === "tool_call") toolDecisions.set(toolCallId, lastDecision);
  }
  return rows.slice(-40);
}

function rowFromWorkerTranscriptEvent(
  event: Record<string, unknown>,
  index: number,
  previousDecision: Record<string, unknown> | null = null,
  toolDecisions: Map<string, Record<string, unknown>> = new Map(),
): WorkerActivityProgressRow | null {
  const kind = typeof event.kind === "string" ? event.kind : "";
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  if (kind === "system" && payload.category === "public_work_decision") {
    const decision = transcriptDecisionFromPayload(payload) ?? payload;
    const title = safeTimelineText(decision.decisionSummary ?? decision.summary, 180) ?? "Recorded worker decision.";
    const createdAt = transcriptEventCreatedAt(event);
    const decisionId = safeActivityToken(decision.decisionId) ?? `worker-transcript-decision-${index + 1}`;
    return {
      id: safeActivityToken(event.id ?? event.eventId) ?? `worker-transcript-decision-${index + 1}`,
      kind: "decision",
      safe_label: title,
      state: "delivered",
      safe_tool_name: "Decision",
      work_block_id: `worker-transcript-decision-${decisionId}`,
      work_block_label: title,
      ...workerDecisionFieldsFromRecord(decision),
      created_at: createdAt,
    };
  }
  if (kind !== "tool_call" && kind !== "tool_result") return null;
  const name = safeTimelineText(payload.name, 80) ?? "tool";
  const toolCallId = safeActivityToken(payload.tool_call_id ?? payload.id) ?? `transcript-tool-${index + 1}`;
  const decision = transcriptDecisionFromPayload(payload) ?? toolDecisions.get(toolCallId) ?? previousDecision;
  const decisionFields = decision ? workerDecisionFieldsFromRecord(decision) : {};
  const decisionSummary = decisionFields.work_decision_summary;
  const workBlockId = decision
    ? `worker-transcript-decision-${safeActivityToken(decision.decisionId) ?? toolCallId}`
    : toolCallId;
  const toolName = transcriptToolDisplayName(name);
  const label = transcriptToolLabel(name, kind);
  const command = transcriptCommandLabel(payload);
  const createdAt = transcriptEventCreatedAt(event);
  const detailRows = transcriptToolDetailRows(payload, command);
  return {
    id: safeActivityToken(event.id ?? event.eventId) ?? `${toolCallId}-${kind}`,
    kind: name === "run_command" ? "ran_command" : kind === "tool_call" ? "used_tool" : "tool_result",
    safe_label: label,
    state: kind === "tool_result" ? "delivered" : "running",
    safe_tool_name: toolName,
    ...(command ? { safe_input_label: command } : {}),
    ...(detailRows.length > 0 ? { safe_detail_rows: detailRows } : {}),
    tool_call_id: toolCallId,
    work_block_id: workBlockId,
    work_block_label: decisionSummary ?? label,
    ...decisionFields,
    created_at: createdAt,
  };
}

function transcriptDecisionFromPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (payload.decision && typeof payload.decision === "object") return payload.decision as Record<string, unknown>;
  if (payload.publicDecision && typeof payload.publicDecision === "object") return payload.publicDecision as Record<string, unknown>;
  if (payload.public_work_decision && typeof payload.public_work_decision === "object") return payload.public_work_decision as Record<string, unknown>;
  return null;
}

function transcriptEventCreatedAt(event: Record<string, unknown>): string {
  return typeof event.created_at === "string"
    ? event.created_at
    : typeof event.timestamp === "string"
      ? event.timestamp
      : new Date(0).toISOString();
}

function transcriptToolDisplayName(name: string): string {
  return name === "run_command" ? "Bash" : name;
}

function transcriptToolLabel(name: string, kind: string): string {
  if (name === "run_command") return "Bash";
  return kind === "tool_call" ? `Started ${name}.` : `Completed ${name}.`;
}

function transcriptCommandLabel(payload: Record<string, unknown>): string | null {
  const args = payload.arguments && typeof payload.arguments === "object" ? payload.arguments as Record<string, unknown> : {};
  const result = payload.result && typeof payload.result === "object" ? payload.result as Record<string, unknown> : {};
  return safeTimelineCommandText(args.command, 220) ?? safeTimelineCommandText(result.command, 220);
}

function transcriptToolDetailRows(
  payload: Record<string, unknown>,
  command: string | null,
): WorkerActivityProgressDetailRow[] {
  const args = payload.arguments && typeof payload.arguments === "object" ? payload.arguments as Record<string, unknown> : {};
  const result = payload.result && typeof payload.result === "object" ? payload.result as Record<string, unknown> : {};
  const rows: WorkerActivityProgressDetailRow[] = [];
  if (command) {
    rows.push({
      id: "command",
      safe_label: "Command",
      safe_value: command,
    });
  }
  const cwd = safeTimelineCommandText(args.cwd ?? result.cwd, 180);
  if (cwd) {
    rows.push({
      id: "cwd",
      safe_label: "CWD",
      safe_value: cwd,
    });
  }
  const exitCode = typeof result.exit_code === "number" ? String(result.exit_code) : null;
  if (exitCode) {
    rows.push({
      id: "exit-code",
      safe_label: "Exit",
      safe_value: exitCode,
    });
  }
  return rows.slice(0, 4);
}

function safeTimelineCommandText(value: unknown, limit: number): string | null {
  const text = safeActivityText(value, limit);
  if (!text) return null;
  const normalized = text
    .replace(/\/Users\/[^/\s"'`]+/gu, "~")
    .replace(/\/home\/[^/\s"'`]+/gu, "~")
    .replace(/\/private\/var\/folders\/[^\s"'`]+/gu, "$TMPDIR")
    .replace(/\/var\/folders\/[^\s"'`]+/gu, "$TMPDIR");
  if (looksUnsafeTimelineText(normalized)) return null;
  return normalized;
}

function workerDecisionFieldsFromRecord(
  record: Record<string, unknown>,
): Partial<WorkerActivityProgressRow> {
  const summary = safeTimelineText(record.decision_summary ?? record.decisionSummary ?? record.summary, 220);
  const rationale = safeTimelineText(record.decision_rationale ?? record.decisionRationale ?? record.rationale, 300);
  const nextStep = safeTimelineText(record.decision_next_step ?? record.decisionNextStep ?? record.nextStep, 300);
  const source = safeTimelineText(record.decision_source ?? record.decisionSource ?? record.source, 80);
  const rawRefs = record.evidence_refs ?? record.decision_evidence_refs ?? record.decisionEvidenceRefs ?? record.evidenceRefs;
  const refs = Array.isArray(rawRefs)
    ? rawRefs.map((ref) => safeTimelineText(ref, 220)).filter((ref): ref is string => Boolean(ref)).slice(0, 8)
    : [];
  return {
    ...(summary ? { work_decision_summary: summary } : {}),
    ...(rationale ? { work_decision_rationale: rationale } : {}),
    ...(nextStep ? { work_decision_next_step: nextStep } : {}),
    ...(source ? { work_decision_source: source } : {}),
    ...(refs.length > 0 ? { work_decision_evidence_refs: refs } : {}),
  };
}

function readJsonlRecords(path: string): Array<Record<string, unknown>> {
  const raw = readText(path);
  if (!raw) return [];
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
      } catch {
        return null;
      }
    })
    .filter((record): record is Record<string, unknown> => Boolean(record));
}

function safeTimelineKind(value: unknown): string {
  const text = safeTimelineText(value, 60);
  return text?.replace(/[^a-zA-Z0-9_.:-]/gu, "_") || "used_tool";
}

function safeTimelineText(value: unknown, limit: number): string | null {
  const text = safeActivityText(value, limit);
  if (!text || looksUnsafeTimelineText(text)) return null;
  return text;
}

function looksUnsafeTimelineText(value: string): boolean {
  return /<\s*\/?\s*(?:think|thinking|reasoning)\b[^>]*>/iu.test(value) ||
    /\b(?:hidden reasoning|chain[- ]of[- ]thought|scratchpad|raw prompt|raw transcript|provider payload|argumentsJson|sessionId|eventId|tool_call|tool_result)\b/iu.test(value) ||
    /\b(?:api[_-]?key|token|secret|password|authorization|auth)\s*[:=]\s*(?:bearer\s+)?\S+/iu.test(value) ||
    /(?:^|[\s"'`:=])\/(?:Users|private|tmp|var\/folders|home|Volumes|opt|usr|etc)\b/u.test(value) ||
    /^\s*[{[]/u.test(value);
}

function workerTimelineFallbackLabel(kind: string): string {
  if (kind === "run_command") return "Running a worker tool.";
  if (kind === "tool_call") return "Starting a worker tool.";
  if (kind === "tool_result") return "Recording a worker tool result.";
  if (kind === "evidence_receipt") return "Recording worker evidence.";
  return "Updating worker progress.";
}

function workerTimelineState(
  eventName: string,
  record: Record<string, unknown>,
): string {
  const state = safeActivityText(record.state, 40);
  if (state) return state;
  if (eventName === "tool_call") return "running";
  if (
    eventName === "activity_updated" ||
    eventName === "tool_result" ||
    eventName === "evidence_receipt" ||
    eventName === "public_work_decision"
  ) return "delivered";
  return "running";
}

function sanitizeWorkerTranscriptId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function safeWorkerActivityWorkBlocks(value: unknown): WorkerActivityWorkBlock[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((block) => {
      if (!block || typeof block !== "object") return null;
      const record = block as Record<string, unknown>;
      const id = safeActivityToken(record.id);
      const label = safeActivityText(record.label, 180);
      if (!id || !label) return null;
      return {
        id,
        label,
        state: safeActivityText(record.state, 40) || "running",
        rows: safeWorkerActivityRows(record.rows),
        ...(safeActivityText(record.decision_summary, 220) ? { decision_summary: safeActivityText(record.decision_summary, 220)! } : {}),
        ...(safeActivityText(record.decision_rationale, 300) ? { decision_rationale: safeActivityText(record.decision_rationale, 300)! } : {}),
        ...(safeActivityText(record.decision_next_step, 300) ? { decision_next_step: safeActivityText(record.decision_next_step, 300)! } : {}),
        ...(safeActivityText(record.decision_source, 80) ? { decision_source: safeActivityText(record.decision_source, 80)! } : {}),
        ...(Array.isArray(record.decision_evidence_refs) ? { decision_evidence_refs: record.decision_evidence_refs.map((ref) => safeActivityText(ref, 220)).filter((ref): ref is string => Boolean(ref)).slice(0, 8) } : {}),
        ...(typeof record.created_at === "string" ? { created_at: record.created_at } : {}),
      } satisfies WorkerActivityWorkBlock;
    })
    .filter((block): block is WorkerActivityWorkBlock => Boolean(block))
    .slice(-25);
}

function safeWorkerActivityRows(value: unknown): WorkerActivityProgressRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const record = row as Record<string, unknown>;
      const id = safeActivityToken(record.id);
      const safeLabel = safeActivityText(record.safe_label, 220);
      if (!id || !safeLabel) return null;
      const safeToolName = safeActivityText(record.safe_tool_name, 80);
      const safeInputLabel = safeActivityText(record.safe_input_label, 220);
      const toolCallId = safeActivityText(record.tool_call_id, 120);
      const workBlockId = safeActivityText(record.work_block_id, 120);
      const workBlockLabel = safeActivityText(record.work_block_label, 180);
      const detailRows = safeWorkerActivityDetailRows(record.safe_detail_rows);
      const decisionFields = workerDecisionFieldsFromRecord(record);
      return {
        id,
        kind: safeActivityText(record.kind, 60) || "used_tool",
        safe_label: safeLabel,
        state: safeActivityText(record.state, 40) || "running",
        ...(safeToolName ? { safe_tool_name: safeToolName } : {}),
        ...(safeInputLabel ? { safe_input_label: safeInputLabel } : {}),
        ...(toolCallId ? { tool_call_id: toolCallId } : {}),
        ...(workBlockId ? { work_block_id: workBlockId } : {}),
        ...(workBlockLabel ? { work_block_label: workBlockLabel } : {}),
        ...decisionFields,
        ...(detailRows.length > 0 ? { safe_detail_rows: detailRows } : {}),
        created_at: typeof record.created_at === "string" ? record.created_at : new Date(0).toISOString(),
      } satisfies WorkerActivityProgressRow;
    })
    .filter((row): row is WorkerActivityProgressRow => Boolean(row))
    .slice(-40);
}

function safeWorkerActivityDetailRows(value: unknown): WorkerActivityProgressDetailRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const record = row as Record<string, unknown>;
      const id = safeActivityToken(record.id);
      const safeLabel = safeActivityText(record.safe_label, 80);
      if (!id || !safeLabel) return null;
      const kind = safeActivityText(record.kind, 60);
      const safeValue = safeActivityText(record.safe_value, 220);
      const state = safeActivityText(record.state, 40);
      return {
        id,
        ...(kind ? { kind } : {}),
        safe_label: safeLabel,
        ...(safeValue ? { safe_value: safeValue } : {}),
        ...(state ? { state } : {}),
      } satisfies WorkerActivityProgressDetailRow;
    })
    .filter((row): row is WorkerActivityProgressDetailRow => Boolean(row))
    .slice(0, 8);
}

function safeActivityToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.replace(/[^a-zA-Z0-9_.:-]/gu, "-").slice(0, 120);
  return token || null;
}

function safeActivityText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  return compactOneLine(value, limit) || null;
}

function taskUpdatedAt(taskDir: string): string | null {
  try {
    return statSync(join(taskDir, "status")).mtime.toISOString();
  } catch {
    return null;
  }
}

export class TaskStore {
  readonly tasksDir: string;

  constructor(readonly butlerData: string) {
    this.tasksDir = join(butlerData, "tasks");
  }

  ensure(): void {
    mkdirSync(this.tasksDir, { recursive: true });
  }

  taskDir(taskId: string): string {
    return join(this.tasksDir, taskId);
  }

  taskIds(): string[] {
    if (!existsSync(this.tasksDir)) return [];
    return readdirSync(this.tasksDir).filter((taskId) =>
      existsSync(join(this.tasksDir, taskId, "status")),
    );
  }

  read(taskId: string): TaskRecord | null {
    const taskDir = this.taskDir(taskId);
    if (!existsSync(taskDir)) return null;
    const notifiedAt =
      readText(join(taskDir, NOTIFIED_MARKER)) ||
      readText(join(taskDir, LEGACY_NOTIFIED_MARKER)) ||
      null;
    const result = readText(join(taskDir, "result.md")) || null;
    const log = readText(join(taskDir, "log.txt"));
    const logSummary = summarizeWorkerLog(log);
    const planned = readPlannedTaskRecord(taskDir, taskId);
    const completionEvidence = summarizeWorkerCompletionEvidence(taskDir);
    return {
      taskId,
      taskDir,
      status: normalizeStatus(readText(join(taskDir, "status"))),
      project: readText(join(taskDir, "project")) || null,
      request: readText(join(taskDir, "request.md")) || null,
      result,
      observedResult: isGenericResult(result) && logSummary
        ? `${logSummary}\n\nWorker result file: ${result}`
        : result || logSummary,
      logTail: tailText(log, 4_000) || null,
      hasResult: Boolean(result),
      notifiedAt,
      origin: readTaskOrigin(taskDir),
      planned,
      completionEvidence,
    };
  }

  list(limit = 10): TaskRecord[] {
    const safeLimit = Math.max(1, Math.min(250, Math.trunc(limit)));
    return this.taskIds()
      .map((taskId) => this.read(taskId))
      .filter((task): task is TaskRecord => Boolean(task))
      .sort((a, b) => b.taskId.localeCompare(a.taskId))
      .slice(0, safeLimit);
  }

  summaries(limit = 10): TaskSummary[] {
    return this.list(limit).map((task) => {
      const publicReportReady = Boolean(task.planned?.publicReport);
      const safety = workSafetyForTask(task);
      const activity = readWorkerActivityProjection(task.taskDir);
      return {
        task_id: task.taskId,
        task_type: task.planned ? "planned" : "direct",
        status: task.status,
        project: task.project,
        origin_session_id: task.origin?.origin_session_id ?? null,
        origin_project: task.origin?.project ?? null,
        request: task.request?.slice(0, 500) || null,
        has_result: task.hasResult,
        has_log: Boolean(task.logTail),
        observed_result_preview: task.observedResult?.slice(0, 700) || null,
        origin_summary: task.origin?.task_summary ?? null,
        planned_status: task.planned?.status ?? null,
        planned_goal: task.planned?.plan.goal ?? null,
        review_verdict: task.planned?.review?.verdict ?? null,
        public_report_ready: publicReportReady,
        work_mode: safety.work_mode,
        safe_to_report: safety.safe_to_report,
        completion_claim_allowed: safety.completion_claim_allowed,
        guard_reason: safety.guard_reason,
        can_resume: task.status === "RECOVERABLE",
        user_summary: taskUserSummary(task),
        next_step: taskNextStep(task),
        activity_phase: activity.semantic_phase ?? activity.phase,
        activity_semantic_phase: activity.semantic_phase,
        activity_action_kind: activity.action_kind,
        activity_status_line: activity.status_line,
        activity_current_title: activity.current_title,
        activity_work_blocks: activity.work_blocks,
        activity_updated_at: activity.updated_at,
        completion_evidence: task.completionEvidence,
        updated_at: taskUpdatedAt(task.taskDir),
      };
    });
  }

  reportableTasks(): TaskRecord[] {
    const reportable = new Set<TaskStatus>(["DONE", "FAILED", "REVIEWED"]);
    return this.list(250).filter((task) => reportable.has(task.status) && workSafetyForTask(task).safe_to_report);
  }

  plannedReportReadyTasks(): TaskRecord[] {
    return this.taskIds()
      .map((taskId) => this.read(taskId))
      .filter((task): task is TaskRecord =>
        Boolean(
          task?.planned?.publicReport &&
          (task.planned.status === "PUBLIC_REPORT_READY" ||
            task.planned.status === "FAILED_PUBLIC_REPORT_READY"),
        ),
      )
      .sort((a, b) => b.taskId.localeCompare(a.taskId));
  }

  latestRecoverableTask(): TaskRecord | null {
    return this.list(25).find((task) => task.status === "RECOVERABLE") ?? null;
  }

  reconcileRecoverableTasks(options: {
    isPidAlive?: (pid: number) => boolean;
  } = {}): TaskRecoveryReconcileResult[] {
    const isPidAlive = options.isPidAlive ?? ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    const results: TaskRecoveryReconcileResult[] = [];
    for (const taskId of this.taskIds()) {
      const task = this.read(taskId);
      if (!task || task.status !== "RUNNING") continue;
      const pidText = readText(join(task.taskDir, "pid"));
      const pid = Number.parseInt(pidText, 10);
      if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) continue;

      const hasRecoverableContext = Boolean(task.request || task.origin || task.logTail || task.observedResult);
      const nextStatus: TaskStatus = hasRecoverableContext ? "RECOVERABLE" : "FAILED";
      const reason = hasRecoverableContext
        ? "running worker process is missing; durable context is available"
        : "running worker process is missing and no recoverable context was found";
      writeText(join(task.taskDir, "status"), `${nextStatus}\n`);
      writeText(join(task.taskDir, ".recovery-reconciled"), `${new Date().toISOString()} ${reason}\n`);
      results.push({
        task_id: taskId,
        from: "RUNNING",
        to: nextStatus,
        reason,
      });
    }
    return results;
  }

  markResultNotified(taskId: string, at = new Date()): void {
    const taskDir = this.taskDir(taskId);
    mkdirSync(taskDir, { recursive: true });
    writeText(join(taskDir, NOTIFIED_MARKER), `${at.toISOString()}\n`);
  }

  writeOrigin(taskId: string, origin: TaskOriginContext): void {
    const taskDir = this.taskDir(taskId);
    mkdirSync(taskDir, { recursive: true });
    writeTaskOrigin(taskDir, origin);
  }

  resolveOrigin(taskId: string): ResolvedTaskOriginContext | null {
    return resolveTaskOriginContext({
      taskDir: this.taskDir(taskId),
      butlerData: this.butlerData,
    });
  }
}
