import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { writeLockedTextFile } from "./file-state.ts";

export type PlannedTaskStatus =
  | "PLANNED"
  | "PLANNED_RUNNING"
  | "WORKER_DONE"
  | "WORKER_FAILED"
  | "REVIEWING"
  | "REVIEW_PASSED"
  | "REVIEW_FAILED"
  | "REVIEW_INCONCLUSIVE"
  | "REPAIRING"
  | "PUBLIC_REPORT_READY"
  | "FAILED_PUBLIC_REPORT_READY"
  | "BLOCKED_WAITING_PRINCIPAL"
  | "REPORTED"
  | "CANCELLED";

export type PlannedReviewVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export type PlannedWorkMode =
  | "planning"
  | "executing"
  | "reviewing"
  | "repairing"
  | "blocked"
  | "reporting"
  | "complete"
  | "cancelled";

export interface PlannedModeSafety {
  work_mode: PlannedWorkMode;
  safe_to_report: boolean;
  completion_claim_allowed: boolean;
  guard_reason: string | null;
}

export interface PlannedTaskPlan {
  task_id: string;
  type: "planned";
  goal: string;
  internal_goal?: string;
  project: string;
  created_at: string;
  origin_session_id?: string;
  origin_event_id?: string;
  decision_policy: string;
  acceptance_criteria: string[];
  verification_commands: string[];
  review_policy: string;
  repair_policy: {
    max_attempts: number;
    allow_autonomous_repair: boolean;
  };
  public_report_policy: string;
  risk_notes?: string[];
  source_context?: string;
}

export interface PlannedCriterionReview {
  criterion_index?: number;
  criterion: string;
  verdict: PlannedReviewVerdict;
  evidence: string;
}

export interface PlannedGoalReview {
  goal: string;
  verdict: PlannedReviewVerdict;
  evidence: string;
}

export interface PlannedTaskReview {
  task_id: string;
  attempt: number;
  verdict: PlannedReviewVerdict;
  reviewed_at: string;
  goal_review: PlannedGoalReview;
  criteria: PlannedCriterionReview[];
  missing_evidence: string[];
  repair_recommendation: string | null;
}

export type PlannedTaskReviewInput =
  Omit<PlannedTaskReview, "goal_review"> & { goal_review?: PlannedGoalReview };

export interface PlannedDecisionOption {
  id: string;
  label: string;
  description: string;
}

export interface PlannedDecisionRequest {
  decision_id: string;
  task_id: string;
  situation: string;
  recommended_option_id: string;
  options: PlannedDecisionOption[];
  tradeoffs: string[];
  expires_at: string | null;
  created_at: string;
  response: {
    option_id: string;
    answered_at: string;
    transport?: string;
    actor_id?: string;
  } | null;
}

export interface PlannedTaskRecord {
  taskId: string;
  taskDir: string;
  status: PlannedTaskStatus;
  plan: PlannedTaskPlan;
  attempts: string[];
  latestResult: string | null;
  review: PlannedTaskReview | null;
  decision: PlannedDecisionRequest | null;
  publicReport: string | null;
}

export interface PlannedWorkerAttemptLink {
  record: PlannedTaskRecord;
  attempt: number;
  workerTaskId: string;
}

const STATUS_TRANSITIONS: Record<PlannedTaskStatus, PlannedTaskStatus[]> = {
  PLANNED: ["PLANNED_RUNNING", "BLOCKED_WAITING_PRINCIPAL", "CANCELLED"],
  PLANNED_RUNNING: ["WORKER_DONE", "WORKER_FAILED", "CANCELLED"],
  WORKER_DONE: ["REVIEWING", "CANCELLED"],
  WORKER_FAILED: ["REPAIRING", "FAILED_PUBLIC_REPORT_READY", "BLOCKED_WAITING_PRINCIPAL", "CANCELLED"],
  REVIEWING: ["REVIEW_PASSED", "REVIEW_FAILED", "REVIEW_INCONCLUSIVE", "CANCELLED"],
  REVIEW_PASSED: ["PUBLIC_REPORT_READY", "CANCELLED"],
  REVIEW_FAILED: ["REPAIRING", "FAILED_PUBLIC_REPORT_READY", "BLOCKED_WAITING_PRINCIPAL", "CANCELLED"],
  REVIEW_INCONCLUSIVE: ["REPAIRING", "FAILED_PUBLIC_REPORT_READY", "BLOCKED_WAITING_PRINCIPAL", "CANCELLED"],
  REPAIRING: ["PLANNED_RUNNING", "CANCELLED"],
  PUBLIC_REPORT_READY: ["REPORTED", "CANCELLED"],
  FAILED_PUBLIC_REPORT_READY: ["REPORTED", "CANCELLED"],
  BLOCKED_WAITING_PRINCIPAL: ["PLANNED_RUNNING", "REPAIRING", "CANCELLED"],
  REPORTED: [],
  CANCELLED: [],
};

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  writeLockedTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path: string, value: string): void {
  writeLockedTextFile(path, value);
}

function attemptNumberFromDir(entry: string): number {
  const parsed = Number.parseInt(entry, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeStatus(value: string): PlannedTaskStatus {
  const statuses: PlannedTaskStatus[] = [
    "PLANNED",
    "PLANNED_RUNNING",
    "WORKER_DONE",
    "WORKER_FAILED",
    "REVIEWING",
    "REVIEW_PASSED",
    "REVIEW_FAILED",
    "REVIEW_INCONCLUSIVE",
    "REPAIRING",
    "PUBLIC_REPORT_READY",
    "FAILED_PUBLIC_REPORT_READY",
    "BLOCKED_WAITING_PRINCIPAL",
    "REPORTED",
    "CANCELLED",
  ];
  return statuses.includes(value as PlannedTaskStatus) ? value as PlannedTaskStatus : "PLANNED";
}

export function createPlannedTaskId(now = new Date()): string {
  return `planned-${Math.floor(now.getTime() / 1000)}-${Math.floor(Math.random() * 10_000)}`;
}

export function parsePrincipalDecisionCallback(value: string): {
  decisionId: string;
  optionId: string;
} | null {
  const match = value.match(/^pd:([^:]+):([^:]+)$/);
  if (!match) return null;
  return {
    decisionId: match[1]!,
    optionId: match[2]!,
  };
}

export function validatePlannedTaskPlan(plan: PlannedTaskPlan): void {
  if (!plan.task_id.trim()) throw new Error("planned task requires task_id");
  if (plan.type !== "planned") throw new Error("planned task type must be planned");
  if (!plan.goal.trim()) throw new Error("planned task requires goal");
  if (plan.internal_goal !== undefined && !plan.internal_goal.trim()) {
    throw new Error("planned task internal_goal must be non-empty when provided");
  }
  if (!plan.project.trim()) throw new Error("planned task requires project");
  if (!Array.isArray(plan.acceptance_criteria) || plan.acceptance_criteria.filter((item) => item.trim()).length === 0) {
    throw new Error("planned task requires non-empty acceptance criteria");
  }
  if (plan.repair_policy.max_attempts < 0) {
    throw new Error("planned task repair max_attempts must be non-negative");
  }
}

export function plannedInternalGoal(plan: PlannedTaskPlan): string {
  return plan.internal_goal?.trim() || plan.goal.trim();
}

export function plannedWorkMode(status: PlannedTaskStatus): PlannedWorkMode {
  if (status === "PLANNED") return "planning";
  if (status === "PLANNED_RUNNING") return "executing";
  if (
    status === "WORKER_DONE" ||
    status === "REVIEWING" ||
    status === "REVIEW_FAILED" ||
    status === "REVIEW_INCONCLUSIVE"
  ) return "reviewing";
  if (status === "WORKER_FAILED" || status === "REPAIRING") return "repairing";
  if (status === "BLOCKED_WAITING_PRINCIPAL") return "blocked";
  if (
    status === "REVIEW_PASSED" ||
    status === "PUBLIC_REPORT_READY" ||
    status === "FAILED_PUBLIC_REPORT_READY"
  ) return "reporting";
  if (status === "REPORTED") return "complete";
  return "cancelled";
}

export function plannedModeSafety(record: PlannedTaskRecord): PlannedModeSafety {
  const workMode = plannedWorkMode(record.status);
  if (record.status === "PUBLIC_REPORT_READY") {
    return {
      work_mode: workMode,
      safe_to_report: true,
      completion_claim_allowed: true,
      guard_reason: null,
    };
  }
  if (record.status === "FAILED_PUBLIC_REPORT_READY") {
    return {
      work_mode: workMode,
      safe_to_report: true,
      completion_claim_allowed: false,
      guard_reason: "Only a failure or partial-outcome report is ready; do not claim completion.",
    };
  }
  if (record.status === "REPORTED") {
    return {
      work_mode: workMode,
      safe_to_report: true,
      completion_claim_allowed: record.review?.verdict === "PASS",
      guard_reason: null,
    };
  }
  const guardByMode: Record<PlannedWorkMode, string> = {
    planning: "The plan exists but execution has not started.",
    executing: "Planned work is still executing; wait for worker evidence.",
    reviewing: "Review evidence is not complete enough for public completion.",
    repairing: "Repair is required before public completion can be claimed.",
    blocked: "A principal decision is required before work can continue.",
    reporting: "A reviewed public report still needs to be prepared.",
    complete: "Work has already been reported.",
    cancelled: "Work was cancelled.",
  };
  return {
    work_mode: workMode,
    safe_to_report: false,
    completion_claim_allowed: false,
    guard_reason: guardByMode[workMode],
  };
}

export function missingReviewCriteria(record: PlannedTaskRecord, reviews: PlannedCriterionReview[]): string[] {
  const reviewed = new Set(reviews.map((item) => item.criterion.trim().toLowerCase()).filter(Boolean));
  const reviewedIndexes = new Set(
    reviews
      .map((item) => item.criterion_index)
      .filter((index): index is number =>
        typeof index === "number" &&
        Number.isInteger(index) &&
        index >= 1 &&
        index <= record.plan.acceptance_criteria.length,
      )
      .map((index) => index - 1),
  );
  return record.plan.acceptance_criteria
    .map((criterion, index) => ({ criterion: criterion.trim(), index }))
    .filter((item) => item.criterion)
    .filter((item) => !reviewedIndexes.has(item.index))
    .filter((item) => !reviewed.has(item.criterion.toLowerCase()))
    .map((item) => item.criterion);
}

export function readPlannedTaskRecord(taskDir: string, taskId?: string): PlannedTaskRecord | null {
  if (!existsSync(taskDir)) return null;
  const plan = readJson<PlannedTaskPlan>(join(taskDir, "plan.json"));
  if (!plan || plan.type !== "planned") return null;
  const attemptsDir = join(taskDir, "attempts");
  const attempts = existsSync(attemptsDir)
    ? readdirSync(attemptsDir).filter((entry) => existsSync(join(attemptsDir, entry))).sort()
    : [];
  const latest = attempts.at(-1);
  const latestResult = latest ? readText(join(attemptsDir, latest, "result.md")) || null : null;
  return {
    taskId: taskId ?? plan.task_id,
    taskDir,
    status: normalizeStatus(readText(join(taskDir, "status"))),
    plan,
    attempts,
    latestResult,
    review: readJson<PlannedTaskReview>(join(taskDir, "review.json")),
    decision: readJson<PlannedDecisionRequest>(join(taskDir, "decision.json")),
    publicReport: readText(join(taskDir, "public-report.md")) || null,
  };
}

export class PlannedTaskStore {
  readonly tasksDir: string;

  constructor(readonly butlerData: string) {
    this.tasksDir = join(butlerData, "tasks");
  }

  taskDir(taskId: string): string {
    return join(this.tasksDir, taskId);
  }

  create(plan: PlannedTaskPlan): PlannedTaskRecord {
    validatePlannedTaskPlan(plan);
    const taskDir = this.taskDir(plan.task_id);
    mkdirSync(join(taskDir, "attempts"), { recursive: true });
    writeJson(join(taskDir, "plan.json"), plan);
    writeText(join(taskDir, "plan.md"), renderPlanMarkdown(plan));
    writeText(join(taskDir, "status"), "PLANNED\n");
    return this.read(plan.task_id)!;
  }

  read(taskId: string): PlannedTaskRecord | null {
    return readPlannedTaskRecord(this.taskDir(taskId), taskId);
  }

  summaries(limit = 10): Array<{
    task_id: string;
    status: PlannedTaskStatus;
    goal: string;
    project: string;
    review_verdict: PlannedReviewVerdict | null;
    public_report_ready: boolean;
    attempts: number;
  }> {
    const safeLimit = Math.max(1, Math.min(25, Math.trunc(limit)));
    if (!existsSync(this.tasksDir)) return [];
    return readdirSync(this.tasksDir)
      .map((taskId) => this.read(taskId))
      .filter((record): record is PlannedTaskRecord => Boolean(record))
      .sort((a, b) => b.taskId.localeCompare(a.taskId))
      .slice(0, safeLimit)
      .map((record) => ({
        task_id: record.taskId,
        status: record.status,
        goal: record.plan.goal,
        project: record.plan.project,
        review_verdict: record.review?.verdict ?? null,
        public_report_ready: Boolean(record.publicReport),
        attempts: record.attempts.length,
      }));
  }

  findByWorkerTaskId(workerTaskId: string): PlannedWorkerAttemptLink | null {
    const normalizedTaskId = workerTaskId.trim();
    return this.findByWorkerTaskIds(new Set([normalizedTaskId])).get(normalizedTaskId) ?? null;
  }

  findByWorkerTaskIds(
    workerTaskIds: ReadonlySet<string>,
  ): Map<string, PlannedWorkerAttemptLink> {
    const targets = new Set(
      [...workerTaskIds].map((taskId) => taskId.trim()).filter(Boolean),
    );
    const links = new Map<string, PlannedWorkerAttemptLink>();
    if (targets.size === 0 || !existsSync(this.tasksDir)) return links;
    for (const taskId of readdirSync(this.tasksDir)) {
      const record = this.read(taskId);
      if (!record) continue;
      for (const attempt of record.attempts) {
        const linkedWorkerTaskId = readText(join(record.taskDir, "attempts", attempt, "worker-task-id"));
        if (targets.has(linkedWorkerTaskId) && !links.has(linkedWorkerTaskId)) {
          links.set(linkedWorkerTaskId, {
            record,
            attempt: attemptNumberFromDir(attempt),
            workerTaskId: linkedWorkerTaskId,
          });
          if (links.size === targets.size) return links;
        }
      }
    }
    return links;
  }

  transition(taskId: string, next: PlannedTaskStatus): PlannedTaskRecord {
    const record = this.read(taskId);
    if (!record) throw new Error(`planned task ${taskId} not found`);
    const allowed = STATUS_TRANSITIONS[record.status] ?? [];
    if (!allowed.includes(next)) {
      throw new Error(`invalid planned task transition ${record.status} -> ${next}`);
    }
    writeText(join(record.taskDir, "status"), `${next}\n`);
    return this.read(taskId)!;
  }

  writeAttemptResult(taskId: string, attempt: number, result: string): PlannedTaskRecord {
    const record = this.read(taskId);
    if (!record) throw new Error(`planned task ${taskId} not found`);
    const attemptDir = join(record.taskDir, "attempts", String(attempt).padStart(3, "0"));
    mkdirSync(attemptDir, { recursive: true });
    writeText(join(attemptDir, "result.md"), result.trim() ? `${result.trim()}\n` : "");
    return this.read(taskId)!;
  }

  writeAttemptDispatch(
    taskId: string,
    attempt: number,
    input: {
      worker_task_id: string;
      prompt: string;
    },
  ): PlannedTaskRecord {
    const record = this.read(taskId);
    if (!record) throw new Error(`planned task ${taskId} not found`);
    const attemptDir = join(record.taskDir, "attempts", String(attempt).padStart(3, "0"));
    mkdirSync(attemptDir, { recursive: true });
    writeText(join(attemptDir, "worker-task-id"), `${input.worker_task_id.trim()}\n`);
    writeText(join(attemptDir, "prompt.md"), `${input.prompt.trim()}\n`);
    return this.read(taskId)!;
  }

  writeReview(review: PlannedTaskReviewInput): PlannedTaskRecord {
    const record = this.read(review.task_id);
    if (!record) throw new Error(`planned task ${review.task_id} not found`);
    const internalGoal = plannedInternalGoal(record.plan);
    const normalized: PlannedTaskReview = {
      ...review,
      goal_review: {
        goal: review.goal_review?.goal.trim() || internalGoal,
        verdict: review.goal_review?.verdict ?? review.verdict,
        evidence: review.goal_review?.evidence.trim() ||
          "Compatibility review used the overall planned review verdict.",
      },
    };
    writeJson(join(record.taskDir, "review.json"), normalized);
    writeText(join(record.taskDir, "review.md"), renderReviewMarkdown(normalized));
    return this.read(review.task_id)!;
  }

  writePublicReport(taskId: string, report: string): PlannedTaskRecord {
    const record = this.read(taskId);
    if (!record) throw new Error(`planned task ${taskId} not found`);
    writeText(join(record.taskDir, "public-report.md"), `${report.trim()}\n`);
    return this.read(taskId)!;
  }

  writeDecision(taskId: string, decision: PlannedDecisionRequest): PlannedTaskRecord {
    const record = this.read(taskId);
    if (!record) throw new Error(`planned task ${taskId} not found`);
    writeJson(join(record.taskDir, "decision.json"), decision);
    return this.read(taskId)!;
  }

  findByDecisionId(decisionId: string): PlannedTaskRecord | null {
    if (!decisionId.trim() || !existsSync(this.tasksDir)) return null;
    for (const taskId of readdirSync(this.tasksDir)) {
      const record = this.read(taskId);
      if (record?.decision?.decision_id === decisionId) return record;
    }
    return null;
  }

  answerDecision(input: {
    decisionId: string;
    optionId: string;
    transport?: string;
    actorId?: string;
  }): PlannedTaskRecord {
    const record = this.findByDecisionId(input.decisionId);
    if (!record?.decision) throw new Error(`planned decision ${input.decisionId} not found`);
    if (!record.decision.options.some((option) => option.id === input.optionId)) {
      throw new Error(`planned decision ${input.decisionId} has no option ${input.optionId}`);
    }
    const decision: PlannedDecisionRequest = {
      ...record.decision,
      response: {
        option_id: input.optionId,
        answered_at: new Date().toISOString(),
        transport: input.transport,
        actor_id: input.actorId,
      },
    };
    writeJson(join(record.taskDir, "decision.json"), decision);
    return this.read(record.taskId)!;
  }
}

export function renderPlanMarkdown(plan: PlannedTaskPlan): string {
  const internalGoal = plannedInternalGoal(plan);
  return [
    "---",
    `task_id: ${plan.task_id}`,
    "type: planned",
    `goal: ${plan.goal}`,
    `internal_goal: ${internalGoal}`,
    `project: ${plan.project}`,
    `created_at: ${plan.created_at}`,
    "---",
    "",
    `# ${plan.goal}`,
    "",
    "## Internal Goal",
    internalGoal,
    "",
    "## Acceptance Criteria",
    ...plan.acceptance_criteria.map((criterion) => `- ${criterion}`),
    "",
    "## Verification Commands",
    ...(plan.verification_commands.length > 0
      ? plan.verification_commands.map((command) => `- \`${command}\``)
      : ["- Evidence review only; no command is required by this plan."]),
    "",
    "## Review Policy",
    plan.review_policy,
    "",
    "## Repair Policy",
    `Autonomous repair: ${plan.repair_policy.allow_autonomous_repair ? "yes" : "no"}`,
    `Max attempts: ${plan.repair_policy.max_attempts}`,
    "",
  ].join("\n");
}

export function renderReviewMarkdown(review: PlannedTaskReview): string {
  return [
    "---",
    `task_id: ${review.task_id}`,
    `attempt: ${review.attempt}`,
    `verdict: ${review.verdict}`,
    `reviewed_at: ${review.reviewed_at}`,
    "---",
    "",
    "# Planned Task Review",
    "",
    "## Internal Goal Review",
    `- ${review.goal_review.verdict}: ${review.goal_review.goal}`,
    `  Evidence: ${review.goal_review.evidence}`,
    "",
    "## Acceptance Criteria Review",
    ...review.criteria.flatMap((criterion) => [
      `- ${criterion.verdict}: ${criterion.criterion_index ? `AC${criterion.criterion_index}: ` : ""}${criterion.criterion}`,
      `  Evidence: ${criterion.evidence}`,
    ]),
    "",
    "## Missing Evidence",
    ...(review.missing_evidence.length > 0 ? review.missing_evidence.map((item) => `- ${item}`) : ["- None"]),
    "",
    "## Repair Recommendation",
    review.repair_recommendation ?? "None",
    "",
  ].join("\n");
}
