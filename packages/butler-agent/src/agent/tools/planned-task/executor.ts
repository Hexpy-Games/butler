import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { butlerAgentScriptPath } from "../../../runtime/paths.ts";
import { butlerToolProcessEnvironment } from "../executor-support.ts";
import { buildTaskOriginContext } from "../../work/task-origin.ts";
import { TaskStore, workSafetyForTask } from "../../work/task-store.ts";
import { WorkStreamStore } from "../../work/work-stream.ts";
import { WorkOrchestrationStore, orchestrationWorkerPrompt, type WorkStreamInput } from "../../work/work-orchestration.ts";
import {
  createPlannedTaskId,
  missingReviewCriteria,
  plannedInternalGoal,
  PlannedTaskStore,
  type PlannedCriterionReview,
  type PlannedDecisionOption,
  type PlannedDecisionRequest,
  type PlannedGoalReview,
  type PlannedReviewVerdict,
  type PlannedTaskPlan,
} from "../../work/planned-task.ts";
import type { ReasoningEffort } from "../../../integrations/providers/model-catalog.ts";

type ToolCall = { args: Record<string, unknown> };

function createTaskId(): string {
  return `${Math.floor(Date.now() / 1000)}${process.pid}${Math.floor(Math.random() * 10_000)}`;
}

function createDecisionId(): string {
  return randomUUID();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function reviewVerdict(value: unknown): PlannedReviewVerdict {
  return value === "PASS" || value === "FAIL" || value === "INCONCLUSIVE"
    ? value
    : "INCONCLUSIVE";
}

function criterionReviews(value: unknown): PlannedCriterionReview[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      criterion_index:
        typeof item.criterion_index === "number" &&
        Number.isInteger(item.criterion_index) &&
        item.criterion_index > 0
          ? item.criterion_index
          : undefined,
      criterion: typeof item.criterion === "string" ? item.criterion.trim() : "",
      verdict: reviewVerdict(item.verdict),
      evidence: typeof item.evidence === "string" ? item.evidence.trim() : "",
    }))
    .filter((item) => (item.criterion || item.criterion_index) && item.evidence);
}

function canonicalPlannedCriterionReviews(
  record: NonNullable<ReturnType<PlannedTaskStore["read"]>>,
  reviews: PlannedCriterionReview[],
): PlannedCriterionReview[] {
  return reviews.map((review) => {
    const index = review.criterion_index;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 1 ||
      index > record.plan.acceptance_criteria.length
    ) {
      return review;
    }
    return {
      ...review,
      criterion: record.plan.acceptance_criteria[index - 1]?.trim() || review.criterion,
    };
  });
}

function plannedGoalReview(
  value: unknown,
  record: NonNullable<ReturnType<PlannedTaskStore["read"]>>,
  criteriaVerdict: PlannedReviewVerdict,
): {
  review: PlannedGoalReview;
  supplied: boolean;
} {
  const goal = plannedInternalGoal(record.plan);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const evidence = typeof input.evidence === "string" ? input.evidence.trim() : "";
    if (evidence) {
      return {
        supplied: true,
        review: {
          goal,
          verdict: reviewVerdict(input.verdict),
          evidence,
        },
      };
    }
  }
  return {
    supplied: false,
    review: {
      goal,
      verdict: criteriaVerdict === "FAIL" ? "FAIL" : "INCONCLUSIVE",
      evidence: criteriaVerdict === "FAIL"
        ? "Acceptance-criterion review failed before the internal GOAL could pass."
        : "Internal GOAL review evidence was not supplied.",
    },
  };
}

function decisionOptions(value: unknown): PlannedDecisionOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      id: typeof item.id === "string" ? item.id.trim() : "",
      label: typeof item.label === "string" ? item.label.trim() : "",
      description: typeof item.description === "string" ? item.description.trim() : "",
    }))
    .filter((option) => option.id && option.label && option.description);
}

function workStreamInputs(value: unknown): WorkStreamInput[] {
  if (!Array.isArray(value)) throw new Error("create_work_orchestration requires streams");
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : undefined,
      role: typeof item.role === "string" ? item.role : "",
      objective: typeof item.objective === "string" ? item.objective : "",
      acceptance_criteria: stringArray(item.acceptance_criteria),
      depends_on: stringArray(item.depends_on),
    }));
}

function decisionReplyMarkup(decision: PlannedDecisionRequest): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: decision.options.map((option) => {
      const callbackData = `pd:${decision.decision_id}:${option.id}`;
      if (new TextEncoder().encode(callbackData).length > 64) {
        throw new Error(`principal decision callback_data exceeds 64 bytes for option ${option.id}`);
      }
      return [{
        text: option.id === decision.recommended_option_id ? `Recommended: ${option.label}` : option.label,
        callback_data: callbackData,
      }];
    }),
  };
}

function publicReportText(input: {
  record: NonNullable<ReturnType<PlannedTaskStore["read"]>>;
  report: string;
  outcome: string;
  whatWasDone: string[];
  residualRisk: string[];
  nextAction: string;
}): string {
  const report = cleanPublicReport(input.report);
  if (report) return report;
  const lines = [
    input.outcome,
    "",
    "## What Was Done",
    ...input.whatWasDone.map((item) => `- ${item}`),
    "",
    "## Residual Risk",
    ...(input.residualRisk.length > 0 ? input.residualRisk.map((item) => `- ${item}`) : ["- None identified."]),
  ];
  if (input.nextAction) {
    lines.push("", "## Next Action", input.nextAction);
  }
  return lines.join("\n");
}

function cleanPublicReport(value: string): string {
  const text = Array.from(value.trim(), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 && character !== "\n" && character !== "\t" ? " " : character;
  }).join("");
  return text.replace(/\n{4,}/gu, "\n\n\n").trim();
}

function overallReviewVerdict(criteria: PlannedCriterionReview[]): PlannedReviewVerdict {
  if (criteria.some((criterion) => criterion.verdict === "FAIL")) return "FAIL";
  if (criteria.length === 0 || criteria.some((criterion) => criterion.verdict === "INCONCLUSIVE")) {
    return "INCONCLUSIVE";
  }
  return "PASS";
}

function combinedPlannedReviewVerdict(verdicts: PlannedReviewVerdict[]): PlannedReviewVerdict {
  if (verdicts.some((verdict) => verdict === "FAIL")) return "FAIL";
  if (verdicts.some((verdict) => verdict === "INCONCLUSIVE")) return "INCONCLUSIVE";
  return "PASS";
}

function repairPolicy(value: unknown): PlannedTaskPlan["repair_policy"] {
  if (!value || typeof value !== "object") {
    return { max_attempts: 2, allow_autonomous_repair: true };
  }
  const input = value as Record<string, unknown>;
  const maxAttempts = typeof input.max_attempts === "number" && Number.isFinite(input.max_attempts)
    ? Math.max(0, Math.trunc(input.max_attempts))
    : 2;
  const allowAutonomousRepair = typeof input.allow_autonomous_repair === "boolean"
    ? input.allow_autonomous_repair
    : true;
  return {
    max_attempts: maxAttempts,
    allow_autonomous_repair: allowAutonomousRepair,
  };
}

function publicPlanSummary(plan: PlannedTaskPlan): {
  goal: string;
  project: string;
  acceptance_criteria_count: number;
  verification_commands: string[];
  autonomous_repair: boolean;
  max_repair_attempts: number;
  report_policy: string;
} {
  return {
    goal: plan.goal,
    project: plan.project,
    acceptance_criteria_count: plan.acceptance_criteria.length,
    verification_commands: plan.verification_commands,
    autonomous_repair: plan.repair_policy.allow_autonomous_repair,
    max_repair_attempts: plan.repair_policy.max_attempts,
    report_policy: plan.public_report_policy,
  };
}

function boundedPlannedSourceContext(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const compact = compactPlannedSourceContext(text);
  const maxChars = 8_000;
  if (compact.length <= maxChars) return compact;
  const marker = "\n[...original turn context trimmed for planned worker...]\n";
  const headChars = Math.floor((maxChars - marker.length) * 0.65);
  const tailChars = maxChars - marker.length - headChars;
  return [
    compact.slice(0, headChars).trimEnd(),
    marker.trim(),
    compact.slice(Math.max(0, compact.length - tailChars)).trimStart(),
  ].filter(Boolean).join("\n");
}

function compactPlannedSourceContext(text: string): string {
  const keepTitles = new Set([
    "Runtime State",
    "Current Attachment References",
    "Current User Input",
  ]);
  const chunks: string[] = [];
  const hashMatch = text.match(/^Live Configuration Hash: [^\n]+/u);
  if (hashMatch) chunks.push(hashMatch[0]);

  const sectionPattern = /^## ([^\n]+)\n([\s\S]*?)(?=\n---\n\n## |\n## [^\n]+\n|$)/gmu;
  for (const match of text.matchAll(sectionPattern)) {
    const title = match[1]?.trim() ?? "";
    const body = match[2]?.trim() ?? "";
    if (!keepTitles.has(title) || !body) continue;
    chunks.push(`## ${title}\n${body}`);
  }

  return chunks.length > 0 ? chunks.join("\n\n---\n\n") : text;
}

function plannedSourceContextLines(plan: PlannedTaskPlan): string[] {
  const sourceContext = plan.source_context?.trim();
  if (!sourceContext) return [];
  return [
    "",
    "Original Turn Source Context:",
    "Use this bounded context for user-provided files, recent attachments, and immediate conversation references that may not exist in the project workspace.",
    sourceContext,
  ];
}

function plannedWorkerPrompt(plan: PlannedTaskPlan, attempt: number): string {
  return [
    `Execute planned Butler task ${plan.task_id}, attempt ${attempt}.`,
    "",
    `GOAL: ${plannedInternalGoal(plan)}`,
    `User-facing objective: ${plan.goal}`,
    `Project: ${plan.project}`,
    ...plannedSourceContextLines(plan),
    "",
    "Acceptance Criteria:",
    ...plan.acceptance_criteria.map((criterion, index) => `- AC${index + 1}: ${criterion}`),
    "",
    "Verification Commands:",
    ...(plan.verification_commands.length > 0
      ? plan.verification_commands.map((command) => `- ${command}`)
      : ["- Evidence review only; no command is required by this plan."]),
    "",
    "Risk Notes:",
    ...((plan.risk_notes ?? []).length > 0
      ? (plan.risk_notes ?? []).map((note) => `- ${note}`)
      : ["- Stay within the original objective and avoid unrelated changes."]),
    "",
    "Instructions:",
    "- Complete the planned work autonomously within the GOAL and risk boundary.",
    "- Produce evidence for every acceptance criterion.",
    "- Do not report completion unless the GOAL is satisfied or safely failed with evidence.",
    "- Do not ask the principal for routine implementation choices.",
    "- If you hit a critical decision, report the tradeoff clearly instead of guessing.",
  ].join("\n");
}

function plannedRepairPrompt(input: {
  plan: PlannedTaskPlan;
  attempt: number;
  latestResult: string | null;
  review: NonNullable<ReturnType<PlannedTaskStore["read"]>>["review"];
  repairObjective: string;
}): string {
  return [
    `Repair planned Butler task ${input.plan.task_id}, attempt ${input.attempt}.`,
    "",
    `GOAL: ${plannedInternalGoal(input.plan)}`,
    `User-facing objective: ${input.plan.goal}`,
    `Project: ${input.plan.project}`,
    ...plannedSourceContextLines(input.plan),
    "",
    "Repair Objective:",
    input.repairObjective,
    "",
    "Acceptance Criteria:",
    ...input.plan.acceptance_criteria.map((criterion, index) => `- AC${index + 1}: ${criterion}`),
    "",
    "Latest Review:",
    ...(input.review?.criteria.map((criterion) =>
      `- ${criterion.verdict}: ${criterion.criterion}\n  Evidence: ${criterion.evidence}`,
    ) ?? ["- No review details were recorded."]),
    "",
    "Missing Evidence:",
    ...((input.review?.missing_evidence ?? []).length > 0
      ? input.review!.missing_evidence.map((item) => `- ${item}`)
      : ["- None recorded."]),
    "",
    "Repair Recommendation:",
    input.review?.repair_recommendation ?? "Repair the failed or inconclusive criteria.",
    "",
    "Prior Result:",
    input.latestResult ?? "No prior result was recorded.",
    "",
    "Instructions:",
    "- Stay within the original GOAL and risk envelope.",
    "- Fix only the failed or inconclusive criteria unless a dependency is required.",
    "- Produce evidence that the internal GOAL is now complete or safely blocked.",
    "- Produce evidence for every acceptance criterion so the next review can pass.",
  ].join("\n");
}

function repairAttemptsUsed(record: NonNullable<ReturnType<PlannedTaskStore["read"]>>): number {
  return Math.max(0, record.attempts.length - 1);
}

function latestPlannedAttemptNumber(record: NonNullable<ReturnType<PlannedTaskStore["read"]>>): number {
  const latest = Number.parseInt(record.attempts.at(-1) ?? "0", 10);
  return Number.isFinite(latest) ? latest : 0;
}

function plannedAttemptWorkerTaskId(
  record: NonNullable<ReturnType<PlannedTaskStore["read"]>>,
  attempt: number,
): string {
  try {
    return readFileSync(
      join(record.taskDir, "attempts", String(attempt).padStart(3, "0"), "worker-task-id"),
      "utf8",
    ).trim();
  } catch {
    return "";
  }
}

function plannedReviewOwnershipMismatch(input: {
  record: NonNullable<ReturnType<PlannedTaskStore["read"]>>;
  attempt: number;
  workerTaskId?: string;
}): string | null {
  const latestAttempt = latestPlannedAttemptNumber(input.record);
  if (latestAttempt > 0 && input.attempt !== latestAttempt) {
    return `review event targets attempt ${input.attempt}, but latest attempt is ${latestAttempt}`;
  }
  const expectedWorkerTaskId = plannedAttemptWorkerTaskId(input.record, input.attempt);
  if (input.workerTaskId && expectedWorkerTaskId && input.workerTaskId !== expectedWorkerTaskId) {
    return "review event worker task does not match the current planned attempt";
  }
  return null;
}

function stalePlannedReviewResult(input: {
  taskId: string;
  attempt: number;
  status: string;
  reason: string;
  reviewEventId?: string;
}): Record<string, unknown> {
  return {
    ok: false,
    task_id: input.taskId,
    attempt: input.attempt,
    status: input.status,
    classification: "STALE_REVIEW_EVENT",
    review_event_id: input.reviewEventId || null,
    message: "This review event is stale and did not change planned task state.",
    reason: input.reason,
  };
}

function writeRepairFailureReport(input: {
  store: PlannedTaskStore;
  taskId: string;
  reason: string;
  record: NonNullable<ReturnType<PlannedTaskStore["read"]>>;
}): ReturnType<PlannedTaskStore["read"]> {
  const reasonText = input.reason === "repair_cap_exhausted"
    ? "The available autonomous repair attempts have already been used."
    : input.reason === "autonomous_repair_disabled"
      ? "Autonomous repair is disabled for this planned task."
      : "The planned task cannot safely continue without a new decision.";
  const latestReview = input.record.review
    ? `${input.record.review.verdict}: ${input.record.review.repair_recommendation ?? "No specific repair recommendation was recorded."}`
    : "No review was recorded.";
  const lines = [
    "Planned work status report",
    "",
    "What was requested",
    input.record.plan.goal,
    "",
    "What was completed",
    input.record.latestResult
      ? "A worker attempt produced durable result evidence and Butler reviewed it against the plan."
      : "Butler created the plan, but there is not enough durable worker evidence to claim completion.",
    "",
    "Problem found",
    latestReview,
    "",
    "Why Butler is not claiming completion",
    reasonText,
    "",
    "Recommended next action",
    "Review the summarized gap and decide whether to continue with a fresh instruction, adjust the plan, or stop here.",
  ];
  input.store.transition(input.taskId, "FAILED_PUBLIC_REPORT_READY");
  input.store.writePublicReport(input.taskId, lines.join("\n"));
  return input.store.read(input.taskId);
}

export function dispatchBackgroundTask(input: {
  butlerHome: string;
  butlerData: string;
  task: string;
  projectPath: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): { task_id: string; status: "RUNNING"; message: string } {
  const taskId = createTaskId();
  mkdirSync(join(input.butlerData, "tasks"), { recursive: true });
  const dispatchScript = butlerAgentScriptPath(input.butlerHome, "dispatch.sh");
  if (!existsSync(dispatchScript)) {
    throw new Error(`worker dispatch script not found: ${dispatchScript}`);
  }
  const args = [dispatchScript, input.task, input.projectPath];
  const model = input.model?.trim();
  if (model) args.push(model);

  const child = spawn(
    "/bin/bash",
    args,
    {
      cwd: input.butlerHome,
      detached: true,
      stdio: "ignore",
      env: {
        ...butlerToolProcessEnvironment(),
        BUTLER_HOME: input.butlerHome,
        BUTLER_DATA: input.butlerData,
        TASK_ID_OVERRIDE: taskId,
        ...(input.reasoningEffort ? { BUTLER_OPENAI_REASONING_EFFORT: input.reasoningEffort } : {}),
      },
    },
  );
  child.unref();
  return {
    task_id: taskId,
    status: "RUNNING",
    message: "Worker started in the background. The result monitor will report completion.",
  };
}

function recoverableResumePrompt(task: NonNullable<ReturnType<TaskStore["read"]>>): string {
  const parts = [
    `Resume interrupted worker task ${task.taskId}.`,
    "",
    "This worker did not finish normally. Continue from the last reliable state instead of starting over blindly.",
    "First inspect the project and prior task artifacts if needed, then complete the original request.",
    "",
    "Original request:",
    task.request || "(missing)",
  ];
  if (task.origin?.task_summary) {
    parts.push("", "Original task summary:", task.origin.task_summary);
  }
  if (task.observedResult) {
    parts.push("", "Previous observed result or partial result:", task.observedResult.slice(0, 4_000));
  }
  if (task.logTail) {
    parts.push("", "Previous worker log tail:", task.logTail.slice(-4_000));
  }
  parts.push("", `Previous task directory: ${task.taskDir}`);
  return parts.join("\n");
}

type WorkerModelRulePreference = "deep" | "routine";

export interface WorkerModelSelectionRule {
  id?: string;
  label?: string;
  condition?: string;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  enabled?: boolean;
}

function selectWorkerModel(
  input: {
    workerModel?: string;
    workerModelRules?: WorkerModelSelectionRule[];
  },
  preference: WorkerModelRulePreference,
): { model?: string; reasoningEffort?: ReasoningEffort } {
  const rules = (input.workerModelRules ?? [])
    .filter((rule) => rule.enabled !== false && typeof rule.model === "string" && rule.model.trim());
  const preferredRule = rules.find((rule) => workerRuleMatchesPreference(rule, preference)) ?? rules[0];
  if (preferredRule?.model) {
    return {
      model: preferredRule.model.trim(),
      reasoningEffort: preferredRule.reasoning_effort,
    };
  }
  return { model: input.workerModel };
}

function workerRuleMatchesPreference(
  rule: WorkerModelSelectionRule,
  preference: WorkerModelRulePreference,
): boolean {
  const marker = `${rule.id ?? ""} ${rule.label ?? ""}`.toLocaleLowerCase("en-US");
  if (preference === "deep") return /\bdeep(?:[_ -]?work)?\b/u.test(marker);
  return /\broutine(?:[_ -]?work)?\b/u.test(marker);
}

export function createPlannedWorkerToolHandlers(input: {
  butlerHome: string;
  butlerData: string;
  sessionId?: string;
  projectId?: string;
  turnContext?: string;
  workerModel?: string;
  workerModelRules?: WorkerModelSelectionRule[];
  taskStore: TaskStore;
  plannedTaskStore: PlannedTaskStore;
  workStreamStore: WorkStreamStore;
  orchestrationStore: WorkOrchestrationStore;
  dispatchTask?: typeof dispatchBackgroundTask;
}) {
  const taskStore = input.taskStore;
  const plannedTaskStore = input.plannedTaskStore;
  const workStreamStore = input.workStreamStore;
  const orchestrationStore = input.orchestrationStore;
  const dispatchTask = input.dispatchTask ?? dispatchBackgroundTask;
  return {
    "dispatch_worker": async (call: ToolCall) => {
      const task = typeof call.args.task === "string" ? call.args.task.trim() : "";
      if (!task) {
        throw new Error("dispatch_worker requires a non-empty task");
      }
      const projectPath =
        typeof call.args.project_path === "string" && call.args.project_path.trim()
          ? call.args.project_path.trim()
          : input.butlerHome;
      const workerModel = selectWorkerModel(input, "routine");
      const worker = dispatchTask({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        task,
        projectPath,
        model: workerModel.model,
        reasoningEffort: workerModel.reasoningEffort,
      });
      const linkedStream = workStreamStore.link({
        sessionId: input.sessionId,
        workerTaskIds: [worker.task_id],
      });
      return {
        ok: true,
        ...worker,
        work_stream: linkedStream,
      };
    },
    "create_planned_task": async (call: ToolCall) => {
      const goal = typeof call.args.goal === "string" ? call.args.goal.trim() : "";
      if (!goal) {
        throw new Error("create_planned_task requires a non-empty goal");
      }
      const internalGoal =
        typeof call.args.internal_goal === "string" && call.args.internal_goal.trim()
          ? call.args.internal_goal.trim()
          : goal;
      const project =
        typeof call.args.project_path === "string" && call.args.project_path.trim()
          ? call.args.project_path.trim()
          : input.butlerHome;
      const plan: PlannedTaskPlan = {
        task_id: createPlannedTaskId(),
        type: "planned",
        goal,
        internal_goal: internalGoal,
        project,
        created_at: new Date().toISOString(),
        origin_session_id: input.sessionId,
        source_context: boundedPlannedSourceContext(input.turnContext),
        decision_policy:
          "Autonomous by default. Pause only for critical decisions with meaningful tradeoffs.",
        acceptance_criteria: stringArray(call.args.acceptance_criteria),
        verification_commands: stringArray(call.args.verification_commands),
        review_policy:
          "Review every acceptance criterion before producing a public completion report.",
        repair_policy: repairPolicy(call.args.repair_policy),
        public_report_policy:
          typeof call.args.public_report_policy === "string" && call.args.public_report_policy.trim()
            ? call.args.public_report_policy.trim()
            : "Report the reviewed outcome, evidence, residual risk, and next useful action concisely.",
        risk_notes: stringArray(call.args.risk_notes),
      };
      const record = plannedTaskStore.create(plan);
      if (input.sessionId) {
        taskStore.writeOrigin(record.taskId, buildTaskOriginContext({
          sessionId: input.sessionId,
          taskSummary: goal,
          project: input.projectId ?? project,
          topicSummary: "Planned Butler task",
        }));
      }
      const linkedStream = workStreamStore.link({
        sessionId: input.sessionId,
        plannedTaskIds: [record.taskId],
      });
      return {
        ok: true,
        task_id: record.taskId,
        status: record.status,
        public_plan_summary: publicPlanSummary(plan),
        work_stream: linkedStream,
      };
    },
    "run_planned_task": async (call: ToolCall) => {
      const taskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      if (!taskId) {
        throw new Error("run_planned_task requires task_id");
      }
      const record = plannedTaskStore.read(taskId);
      if (!record) {
        throw new Error(`planned task ${taskId} not found`);
      }
      if (record.status !== "PLANNED" && record.status !== "REPAIRING") {
        throw new Error(`invalid planned task transition ${record.status} -> PLANNED_RUNNING`);
      }
      const attempt = record.attempts.length + 1;
      const prompt = plannedWorkerPrompt(record.plan, attempt);
      const workerModel = selectWorkerModel(input, "deep");
      const worker = dispatchTask({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        task: prompt,
        projectPath: record.plan.project,
        model: workerModel.model,
        reasoningEffort: workerModel.reasoningEffort,
      });
      if (input.sessionId) {
        taskStore.writeOrigin(worker.task_id, buildTaskOriginContext({
          sessionId: input.sessionId,
          taskSummary: record.plan.goal,
          project: input.projectId ?? record.plan.project,
          topicSummary: "Planned Butler worker attempt",
        }));
      }
      plannedTaskStore.writeAttemptDispatch(taskId, attempt, {
        worker_task_id: worker.task_id,
        prompt,
      });
      const updated = plannedTaskStore.transition(taskId, "PLANNED_RUNNING");
      const linkedStream = workStreamStore.link({
        sessionId: input.sessionId,
        plannedTaskIds: [updated.taskId],
        workerTaskIds: [worker.task_id],
      });
      return {
        ok: true,
        task_id: updated.taskId,
        worker_task_id: worker.task_id,
        attempt,
        status: updated.status,
        message: "Planned worker attempt started. Review will run before public reporting.",
        work_stream: linkedStream,
      };
    },
    "review_planned_task": async (call: ToolCall) => {
      const taskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      if (!taskId) {
        throw new Error("review_planned_task requires task_id");
      }
      const record = plannedTaskStore.read(taskId);
      if (!record) {
        throw new Error(`planned task ${taskId} not found`);
      }
      const attempt = typeof call.args.attempt === "number" && Number.isFinite(call.args.attempt)
        ? Math.max(1, Math.trunc(call.args.attempt))
        : record.attempts.length || 1;
      if (!record.attempts.includes(String(attempt).padStart(3, "0"))) {
        throw new Error(`planned task ${taskId} has no attempt ${attempt}`);
      }
      const workerTaskId = typeof call.args.worker_task_id === "string" ? call.args.worker_task_id.trim() : "";
      const reviewEventId = typeof call.args.review_event_id === "string" ? call.args.review_event_id.trim() : "";
      const ownershipMismatch = plannedReviewOwnershipMismatch({
        record,
        attempt,
        workerTaskId,
      });
      if (ownershipMismatch) {
        return stalePlannedReviewResult({
          taskId,
          attempt,
          status: record.status,
          reason: ownershipMismatch,
          reviewEventId,
        });
      }
      if (record.status !== "WORKER_DONE") {
        if (workerTaskId || reviewEventId) {
          return stalePlannedReviewResult({
            taskId,
            attempt,
            status: record.status,
            reason: `review event cannot mutate state ${record.status}`,
            reviewEventId,
          });
        }
        throw new Error(`invalid planned task transition ${record.status} -> REVIEWING`);
      }
      const reviews = canonicalPlannedCriterionReviews(record, criterionReviews(call.args.criteria));
      if (reviews.length === 0) {
        throw new Error("review_planned_task requires criterion evidence");
      }
      const missingCriteria = missingReviewCriteria(record, reviews);
      const requestedVerdict = overallReviewVerdict(reviews);
      const criteriaVerdict = requestedVerdict === "PASS" && missingCriteria.length > 0
        ? "INCONCLUSIVE"
        : requestedVerdict;
      const goalReview = plannedGoalReview(call.args.goal_review, record, criteriaVerdict);
      const verdict = combinedPlannedReviewVerdict([criteriaVerdict, goalReview.review.verdict]);
      const missingGoalEvidence = (
        criteriaVerdict === "PASS" &&
        goalReview.review.verdict !== "PASS"
      )
        ? [`Internal GOAL review: ${goalReview.review.evidence}`]
        : [];
      plannedTaskStore.transition(taskId, "REVIEWING");
      plannedTaskStore.writeReview({
        task_id: taskId,
        attempt,
        verdict,
        reviewed_at: new Date().toISOString(),
        goal_review: goalReview.review,
        criteria: reviews,
        missing_evidence: [
          ...stringArray(call.args.missing_evidence),
          ...missingCriteria,
          ...missingGoalEvidence,
        ],
        repair_recommendation:
          typeof call.args.repair_recommendation === "string" && call.args.repair_recommendation.trim()
            ? call.args.repair_recommendation.trim()
            : missingCriteria.length > 0
              ? "Review every acceptance criterion before preparing a public completion report."
              : goalReview.review.verdict !== "PASS"
                ? "Continue the BTCC cycle until the internal GOAL is complete or safely failed with evidence."
              : null,
      });
      const nextStatus = verdict === "PASS"
        ? "REVIEW_PASSED"
        : verdict === "FAIL"
          ? "REVIEW_FAILED"
          : "REVIEW_INCONCLUSIVE";
      const updated = plannedTaskStore.transition(taskId, nextStatus);
      return {
        ok: true,
        task_id: taskId,
        attempt,
        verdict,
        status: updated.status,
        criteria: reviews,
        missing_evidence: updated.review?.missing_evidence ?? [],
        repair_recommendation: updated.review?.repair_recommendation ?? null,
      };
    },
    "repair_planned_task": async (call: ToolCall) => {
      const taskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      if (!taskId) {
        throw new Error("repair_planned_task requires task_id");
      }
      const record = plannedTaskStore.read(taskId);
      if (!record) {
        throw new Error(`planned task ${taskId} not found`);
      }
      const eventAttempt = typeof call.args.attempt === "number" && Number.isFinite(call.args.attempt)
        ? Math.max(1, Math.trunc(call.args.attempt))
        : null;
      const eventWorkerTaskId = typeof call.args.worker_task_id === "string" ? call.args.worker_task_id.trim() : "";
      const eventReviewId = typeof call.args.review_event_id === "string" ? call.args.review_event_id.trim() : "";
      if (eventAttempt) {
        const ownershipMismatch = plannedReviewOwnershipMismatch({
          record,
          attempt: eventAttempt,
          workerTaskId: eventWorkerTaskId,
        });
        if (ownershipMismatch) {
          return stalePlannedReviewResult({
            taskId,
            attempt: eventAttempt,
            status: record.status,
            reason: ownershipMismatch,
            reviewEventId: eventReviewId,
          });
        }
      }
      if (
        record.status !== "REVIEW_FAILED" &&
        record.status !== "REVIEW_INCONCLUSIVE" &&
        record.status !== "WORKER_FAILED"
      ) {
        throw new Error(`invalid planned task repair state ${record.status}`);
      }
      if (!record.plan.repair_policy.allow_autonomous_repair) {
        const failed = writeRepairFailureReport({
          store: plannedTaskStore,
          taskId,
          reason: "autonomous_repair_disabled",
          record,
        });
        return {
          ok: false,
          task_id: taskId,
          status: failed?.status,
          reason: "autonomous_repair_disabled",
          message: "Autonomous repair is disabled for this planned task.",
        };
      }
      if (repairAttemptsUsed(record) >= record.plan.repair_policy.max_attempts) {
        const failed = writeRepairFailureReport({
          store: plannedTaskStore,
          taskId,
          reason: "repair_cap_exhausted",
          record,
        });
        return {
          ok: false,
          task_id: taskId,
          status: failed?.status,
          reason: "repair_cap_exhausted",
          message: "The available autonomous repair attempts have already been used.",
        };
      }

      const repairObjective =
        typeof call.args.repair_objective === "string" && call.args.repair_objective.trim()
          ? call.args.repair_objective.trim()
          : record.review?.repair_recommendation ?? "Repair the failed or inconclusive planned criteria.";
      plannedTaskStore.transition(taskId, "REPAIRING");
      const repairing = plannedTaskStore.read(taskId)!;
      const attempt = repairing.attempts.length + 1;
      const prompt = plannedRepairPrompt({
        plan: repairing.plan,
        attempt,
        latestResult: repairing.latestResult,
        review: repairing.review,
        repairObjective,
      });
      const workerModel = selectWorkerModel(input, "deep");
      const worker = dispatchTask({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        task: prompt,
        projectPath: repairing.plan.project,
        model: workerModel.model,
        reasoningEffort: workerModel.reasoningEffort,
      });
      if (input.sessionId) {
        taskStore.writeOrigin(worker.task_id, buildTaskOriginContext({
          sessionId: input.sessionId,
          taskSummary: repairing.plan.goal,
          project: input.projectId ?? repairing.plan.project,
          topicSummary: "Planned Butler repair attempt",
        }));
      }
      plannedTaskStore.writeAttemptDispatch(taskId, attempt, {
        worker_task_id: worker.task_id,
        prompt,
      });
      const updated = plannedTaskStore.transition(taskId, "PLANNED_RUNNING");
      const linkedStream = workStreamStore.link({
        sessionId: input.sessionId,
        plannedTaskIds: [updated.taskId],
        workerTaskIds: [worker.task_id],
      });
      return {
        ok: true,
        task_id: taskId,
        worker_task_id: worker.task_id,
        attempt,
        status: updated.status,
        message: "Planned repair worker attempt started. Review will run again before public reporting.",
        work_stream: linkedStream,
      };
    },
    "request_principal_decision": async (call: ToolCall) => {
      const taskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      const situation = typeof call.args.situation === "string" ? call.args.situation.trim() : "";
      const recommendedOptionId = typeof call.args.recommended_option_id === "string"
        ? call.args.recommended_option_id.trim()
        : "";
      const options = decisionOptions(call.args.options);
      if (!taskId) throw new Error("request_principal_decision requires task_id");
      if (!situation) throw new Error("request_principal_decision requires situation");
      if (options.length < 2) throw new Error("request_principal_decision requires at least two options");
      if (!options.some((option) => option.id === recommendedOptionId)) {
        throw new Error("request_principal_decision recommended option must match an option id");
      }
      const record = plannedTaskStore.read(taskId);
      if (!record) throw new Error(`planned task ${taskId} not found`);
      const decision: PlannedDecisionRequest = {
        decision_id: createDecisionId(),
        task_id: taskId,
        situation,
        recommended_option_id: recommendedOptionId,
        options,
        tradeoffs: stringArray(call.args.tradeoffs),
        expires_at: typeof call.args.expires_at === "string" && call.args.expires_at.trim()
          ? call.args.expires_at.trim()
          : null,
        created_at: new Date().toISOString(),
        response: null,
      };
      const replyMarkup = decisionReplyMarkup(decision);
      if (record.status !== "BLOCKED_WAITING_PRINCIPAL") {
        plannedTaskStore.transition(taskId, "BLOCKED_WAITING_PRINCIPAL");
      }
      plannedTaskStore.writeDecision(taskId, decision);
      return {
        ok: true,
        task_id: taskId,
        status: "BLOCKED_WAITING_PRINCIPAL",
        decision,
        outbound_event: {
          kind: "principal_decision_requested",
          text: [
            "A critical decision is needed.",
            "",
            situation,
            "",
            `Recommendation: ${recommendedOptionId}`,
          ].join("\n"),
          metadata: {
            replyMarkup,
            decisionId: decision.decision_id,
          },
        },
      };
    },
    "write_planned_public_report": async (call: ToolCall) => {
      const taskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      const userReport = typeof call.args.report === "string" ? call.args.report.trim() : "";
      const outcome = typeof call.args.outcome === "string" ? call.args.outcome.trim() : "";
      if (!taskId) throw new Error("write_planned_public_report requires task_id");
      if (!userReport && !outcome) throw new Error("write_planned_public_report requires report");
      const record = plannedTaskStore.read(taskId);
      if (!record) throw new Error(`planned task ${taskId} not found`);
      if (record.status !== "REVIEW_PASSED" && record.status !== "FAILED_PUBLIC_REPORT_READY") {
        throw new Error(`invalid planned task public report state ${record.status}`);
      }
      if (!record.review) {
        throw new Error("write_planned_public_report requires a recorded planned review");
      }
      if (record.status === "REVIEW_PASSED" && record.review.goal_review?.verdict !== "PASS") {
        throw new Error("write_planned_public_report requires a passing internal GOAL review");
      }
      if (record.status === "FAILED_PUBLIC_REPORT_READY" && record.publicReport) {
        throw new Error("planned failure public report is already ready");
      }
      const report = publicReportText({
        record,
        report: userReport,
        outcome,
        whatWasDone: stringArray(call.args.what_was_done),
        residualRisk: stringArray(call.args.residual_risk),
        nextAction: typeof call.args.next_action === "string" ? call.args.next_action.trim() : "",
      });
      plannedTaskStore.writePublicReport(taskId, report);
      const updated = record.status === "REVIEW_PASSED"
        ? plannedTaskStore.transition(taskId, "PUBLIC_REPORT_READY")
        : plannedTaskStore.read(taskId)!;
      return {
        ok: true,
        task_id: taskId,
        status: updated.status,
        report,
      };
    },
    "resume_worker": async (call: ToolCall) => {
      taskStore.reconcileRecoverableTasks();
      const requestedTaskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      const task = requestedTaskId
        ? taskStore.read(requestedTaskId)
        : taskStore.latestRecoverableTask();
      if (!task) {
        return {
          ok: false,
          error: requestedTaskId
            ? `task ${requestedTaskId} not found`
            : "no recoverable worker task found",
        };
      }
      if (task.status !== "RECOVERABLE") {
        return {
          ok: false,
          task_id: task.taskId,
          status: task.status,
          error: "task is not recoverable",
        };
      }
      const projectPath = task.project && task.project.startsWith("/")
        ? task.project
          : task.origin?.project && task.origin.project.startsWith("/")
            ? task.origin.project
            : input.butlerHome;
      const workerModel = selectWorkerModel(input, "routine");
      const resumed = dispatchTask({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        task: recoverableResumePrompt(task),
        projectPath,
        model: workerModel.model,
        reasoningEffort: workerModel.reasoningEffort,
      });
      return {
        ok: true,
        original_task_id: task.taskId,
        ...resumed,
        message: "Recoverable worker was resumed in a new background task.",
      };
    },
    "create_work_orchestration": async (call: ToolCall) => {
      const goal = typeof call.args.goal === "string" ? call.args.goal.trim() : "";
      if (!goal) throw new Error("create_work_orchestration requires goal");
      const requestedOriginSessionId = typeof call.args.origin_session_id === "string"
        ? call.args.origin_session_id.trim()
        : "";
      if (requestedOriginSessionId && requestedOriginSessionId !== input.sessionId) {
        throw new Error("create_work_orchestration origin_session_id must match active session");
      }
      const orchestration = orchestrationStore.create({
        id: typeof call.args.id === "string" && call.args.id.trim() ? call.args.id.trim() : undefined,
        title: typeof call.args.title === "string" ? call.args.title : undefined,
        goal,
        originSessionId: input.sessionId ?? null,
        streams: workStreamInputs(call.args.streams),
      });
      const linkedStream = workStreamStore.link({
        sessionId: input.sessionId,
        orchestrationIds: [orchestration.id],
      });
      return {
        ok: true,
        orchestration,
        work_stream: linkedStream,
      };
    },
    "run_ready_work_streams": async (call: ToolCall) => {
      const orchestrationId = typeof call.args.orchestration_id === "string" ? call.args.orchestration_id.trim() : "";
      if (!orchestrationId) throw new Error("run_ready_work_streams requires orchestration_id");
      const record = orchestrationStore.read(orchestrationId);
      if (!record) throw new Error(`work orchestration ${orchestrationId} not found`);
      const maxStreams = typeof call.args.max_streams === "number" && Number.isFinite(call.args.max_streams)
        ? Math.max(1, Math.min(10, Math.trunc(call.args.max_streams)))
        : 10;
      const ready = orchestrationStore.readyStreams(orchestrationId).slice(0, maxStreams);
      const dispatches = ready.map((stream) => {
        const workerModel = selectWorkerModel(input, "deep");
        const worker = dispatchTask({
          butlerHome: input.butlerHome,
          butlerData: input.butlerData,
          task: orchestrationWorkerPrompt({ orchestration: record, stream }),
          projectPath: input.butlerHome,
          model: workerModel.model,
          reasoningEffort: workerModel.reasoningEffort,
        });
        return {
          stream_id: stream.id,
          worker_task_id: worker.task_id,
        };
      });
      const linkedStream = workStreamStore.link({
        sessionId: input.sessionId,
        orchestrationIds: [orchestrationId],
        workerTaskIds: dispatches.map((dispatch) => dispatch.worker_task_id),
      });
      return {
        ok: true,
        dispatched: dispatches,
        orchestration: orchestrationStore.markDispatched(orchestrationId, dispatches),
        work_stream: linkedStream,
      };
    },
    "sync_work_orchestration": async (call: ToolCall) => {
      const orchestrationId = typeof call.args.orchestration_id === "string" ? call.args.orchestration_id.trim() : "";
      if (!orchestrationId) throw new Error("sync_work_orchestration requires orchestration_id");
      return {
        ok: true,
        orchestration: orchestrationStore.syncFromTasks(orchestrationId, taskStore),
      };
    },
    "write_work_orchestration_report": async (call: ToolCall) => {
      const orchestrationId = typeof call.args.orchestration_id === "string" ? call.args.orchestration_id.trim() : "";
      const report = typeof call.args.report === "string" ? call.args.report.trim() : "";
      if (!orchestrationId) throw new Error("write_work_orchestration_report requires orchestration_id");
      if (!report) throw new Error("write_work_orchestration_report requires report");
      return {
        ok: true,
        orchestration: orchestrationStore.writeReport(orchestrationId, report),
        work_stream: workStreamStore.link({
          sessionId: input.sessionId,
          orchestrationIds: [orchestrationId],
        }),
      };
    },
    "list_tasks": async (call: ToolCall) => {
      const limit = typeof call.args.limit === "number" && Number.isFinite(call.args.limit)
        ? Math.max(1, Math.min(25, Math.trunc(call.args.limit)))
        : 10;
      const tasks = taskStore.summaries(limit).map((task) => {
        const summary = { ...task };
        delete (summary as Partial<typeof task>).activity_phase;
        delete (summary as Partial<typeof task>).activity_semantic_phase;
        delete (summary as Partial<typeof task>).activity_action_kind;
        delete (summary as Partial<typeof task>).activity_status_line;
        delete (summary as Partial<typeof task>).activity_current_title;
        delete (summary as Partial<typeof task>).activity_work_blocks;
        delete (summary as Partial<typeof task>).activity_updated_at;
        return {
          ...summary,
          ...(task.activity_phase ? { activity_phase: task.activity_phase } : {}),
          ...(task.activity_status_line ? { activity_status_line: task.activity_status_line } : {}),
          ...(task.activity_current_title ? { activity_current_title: task.activity_current_title } : {}),
          ...(task.activity_updated_at ? { activity_updated_at: task.activity_updated_at } : {}),
        };
      });
      return { ok: true, tasks };
    },
    "get_task_result": async (call: ToolCall) => {
      const taskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      if (!taskId) {
        throw new Error("get_task_result requires task_id");
      }
      const task = taskStore.read(taskId);
      if (!task) {
        return { ok: false, task_id: taskId, error: "task not found" };
      }
      const safety = workSafetyForTask(task);
      return {
        ok: true,
        task_id: taskId,
        status: task.status,
        work_mode: safety.work_mode,
        safe_to_report: safety.safe_to_report,
        completion_claim_allowed: safety.completion_claim_allowed,
        guard_reason: safety.guard_reason,
        can_resume: task.status === "RECOVERABLE",
        user_summary: task.origin?.task_summary
          ? `${task.origin.task_summary}: ${task.status}`
          : `${task.request?.slice(0, 160) || `worker task ${task.taskId}`}: ${task.status}`,
        next_step: task.status === "RECOVERABLE"
          ? "Use resume_worker if the principal asks to continue this interrupted task."
          : task.status === "RUNNING"
            ? "Tell the principal this task is still running and avoid claiming completion."
            : "Answer from the durable result and observed log evidence.",
        result: task.result,
        observed_result: task.observedResult,
        log_tail: task.logTail,
        origin: task.origin,
      };
    },
  };
}
