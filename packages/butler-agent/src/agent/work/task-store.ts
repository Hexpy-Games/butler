import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
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
  | "executing"
  | "verifying"
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
  activity_status_line: string | null;
  activity_current_title: string | null;
  activity_work_blocks: WorkerActivityWorkBlock[];
  activity_updated_at: string | null;
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
  writeFileSync(path, value, "utf8");
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

function directModeSafety(status: TaskStatus): {
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
    return {
      work_mode: "complete",
      safe_to_report: true,
      completion_claim_allowed: true,
      guard_reason: null,
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
  if (!task.planned) return directModeSafety(task.status);
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
    value === "executing" ||
    value === "verifying" ||
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
  work_blocks: WorkerActivityWorkBlock[];
  updated_at: string | null;
} {
  const raw = readText(join(taskDir, "worker_activity.json"));
  if (!raw) return { phase: null, status_line: null, current_title: null, work_blocks: [], updated_at: null };
  try {
    const parsed = JSON.parse(raw) as {
      phase?: unknown;
      status_line?: unknown;
      current_title?: unknown;
      work_blocks?: unknown;
      updated_at?: unknown;
    };
    return {
      phase: normalizeWorkerActivityPhase(parsed.phase),
      status_line: typeof parsed.status_line === "string" ? compactOneLine(parsed.status_line, 180) : null,
      current_title: typeof parsed.current_title === "string" ? compactOneLine(parsed.current_title, 180) : null,
      work_blocks: safeWorkerActivityWorkBlocks(parsed.work_blocks),
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : null,
    };
  } catch {
    return { phase: null, status_line: null, current_title: null, work_blocks: [], updated_at: null };
  }
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
        activity_phase: activity.phase,
        activity_status_line: activity.status_line,
        activity_current_title: activity.current_title,
        activity_work_blocks: activity.work_blocks,
        activity_updated_at: activity.updated_at,
        updated_at: taskUpdatedAt(task.taskDir),
      };
    });
  }

  reportableTasks(): TaskRecord[] {
    const reportable = new Set<TaskStatus>(["DONE", "FAILED", "REVIEWED"]);
    return this.list(250).filter((task) => reportable.has(task.status));
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
    writeFileSync(join(taskDir, NOTIFIED_MARKER), `${at.toISOString()}\n`, "utf8");
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
