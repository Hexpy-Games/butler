import { randomUUID } from "crypto";
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { basename, extname, isAbsolute, join, relative, resolve } from "path";
import type {
  AgentRuntimeAdapter,
  ArtifactRef,
  AttachmentRef,
  InboundEnvelope,
  OutboundAction,
  RuntimeSessionHandle,
  RuntimeSessionInit,
  RuntimeTurnInput,
  RuntimeTurnResult,
  SessionRole,
} from "../../test-support/harness/contracts.ts";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
  readTranscript,
  type TranscriptEvent,
} from "../../test-support/harness/transcripts.ts";
import {
  runFunctionToolPromptText,
  runPromptText,
  type FunctionToolPromptOptions,
  type PromptUsageAttribution,
  type PromptUsageBudgetState,
  type PromptUsageSectionAttribution,
} from "../../integrations/providers/provider.ts";
import {
  BUTLER_TOOLS,
  createButlerToolExecutor,
  satisfiedCompletionObligationsForToolResult,
} from "../tools/butler-tools.ts";
import { buildTaskOriginContext } from "../work/task-origin.ts";
import { TaskStore } from "../work/task-store.ts";
import { TodoListStore, type TodoItemInput } from "../work/todo-list.ts";
import {
  completeReportingWorkStreamForSession,
  completeTurnLocalWorkStreamForSession,
  WorkStreamStore,
  workStreamTerminal,
} from "../work/work-stream.ts";
import { appendRuntimeTurnContextMetric } from "../../operations/metrics/context-monitor.ts";
import {
  resolveRuntimeMessageLanguage,
  type RuntimeMessageLanguage,
} from "../output/messages.ts";
import {
  recallMemory,
  recallMemoryWithVector,
  type AssociativeRecallResult,
} from "../cognition/memory/recall/engine.ts";
import { renderFeedbackBufferContext } from "../cognition/feedback/buffer.ts";
import {
  defaultRecentConversationTokenBudget,
  estimateContextTokens,
  takeLinesFromEndWithinBudget,
  type ContextBudgetOverrides,
} from "../context/budget.ts";
import { renderAttachmentContext } from "../context/attachment-context.ts";
import {
  maybeAutoCompactSession,
  readLatestCompactionSnapshot,
  renderCompactionContext,
} from "../context/compaction.ts";
import {
  refreshWorkingMemoryFromTranscript,
  renderWorkingMemoryContext,
} from "../context/working-memory.ts";
import { recordOperationalMetric } from "../../operations/metrics/operational-metrics.ts";
import {
  sanitizePublicText,
  type RuntimeTurnEventInput,
} from "../events/turn-events.ts";
import type {
  PublicWorkDecision,
  ToolAuditEntry,
  ToolProgressSummary,
} from "./native-tool-types.ts";
import {
  applyRuntimeIntentGuardsWithDecision,
  applyWebSearchCitationGuard,
  enforceGroundedActionClaims,
  explicitToolRequirementRepairPrompt,
  hasSuccessfulTool,
  requiredExplicitToolNames,
  shouldEnforceGrounding,
  type RuntimeIntentGuardName,
} from "../policy/runtime-policy.ts";
import {
  completionObligationIncompleteReason,
  containsFinalPublicWorkDecisionLeak,
  containsFinalToolImplementationLeak,
  goalCompletionIncompleteContinuationPrompt,
  completionReviewIncompleteReason,
  finalResultContractRepairPrompt,
  goalCompletionReviewPrompt,
  stripLeadingPublicWorkDecisionBlock,
  stripToolImplementationLeakLines,
} from "../output/final-output-contract.ts";
import {
  summarizeToolProgress,
} from "../output/tool-progress.ts";
import {
  annotateToolResultWithDecisionContext,
  publicWorkDecisionPayload,
  publicWorkDecisionsFromAssistantText,
  takePublicWorkDecisionForTool,
} from "../output/public-work-decisions.ts";
import { evidenceReceiptsFromResult } from "../output/evidence-receipts.ts";
import {
  loadSessionContextPolicyCatalog,
  renderSessionContextPolicyContext,
} from "../policy/session-context-policy.ts";

export {
  applyCorrectionChallengeGuard,
  applyShortCueRhythmGuard,
  applyShortUtteranceCorrectionGuard,
  applyWebSearchCitationGuard,
  enforceGroundedActionClaims,
} from "../policy/runtime-policy.ts";

export interface NativeToolLoopRuntimeOptions {
  runPromptText?: typeof runPromptText;
  runFunctionToolPromptText?: typeof runFunctionToolPromptText;
  executeButlerTool?: FunctionToolPromptOptions["executeTool"];
  butlerHome?: string;
  butlerData?: string;
  appMessageDbPath?: string;
  messageLanguage?: RuntimeMessageLanguage;
  recallMemory?: typeof recallMemory;
  recallMemoryWithVector?: typeof recallMemoryWithVector;
  disableAutomaticRecall?: boolean;
  contextBudgetOverrides?: ContextBudgetOverrides;
  recentConversationTokenBudget?: number;
}

// Keep automatic recall within the same latency envelope as vector.ts' default search budget.
const AUTOMATIC_RECALL_VECTOR_TIMEOUT_MS = 1_500;
const DIRECT_TOOL_CHAIN_MAX_ROUNDS = 60;
const GOAL_COMPLETION_REVIEW_SKIP_TOOLS = new Set([
  "dispatch_worker",
  "resume_worker",
  "run_planned_task",
  "repair_planned_task",
  "run_ready_work_streams",
  "write_planned_public_report",
  "write_work_orchestration_report",
]);
const INTERNAL_PROGRESS_TOOLS = new Set([
  "update_todo_list",
  "list_todo_list",
]);
const WORKER_ORCHESTRATION_START_TOOLS = [
  "dispatch_worker",
  "resume_worker",
  "run_planned_task",
  "repair_planned_task",
  "run_ready_work_streams",
] as const;
const WORKER_ORCHESTRATION_START_TOOL_SET = new Set<string>(WORKER_ORCHESTRATION_START_TOOLS);
const PLANNED_REVIEW_FORBIDDEN_START_TOOLS = new Set<string>([
  "create_planned_task",
  "run_planned_task",
  "dispatch_worker",
  "resume_worker",
  "create_work_orchestration",
  "run_ready_work_streams",
]);
const PLANNED_REVIEW_SCOPED_TOOLS = new Set<string>([
  "review_planned_task",
  "repair_planned_task",
  "request_principal_decision",
  "write_planned_public_report",
]);
const RUNTIME_SEMANTIC_TODO_LIST_ID = "runtime-semantic";
const DEFAULT_GOAL_COMPLETION_CONTINUATION_ATTEMPTS = 8;
const DEFAULT_DIRECT_WORK_CONTINUATION_ATTEMPTS = 100;
const DIRECT_TURN_MODEL_CALL_BUDGET = 32;
const DIRECT_TURN_PROMPT_TOKEN_BUDGET = 220_000;
const DIRECT_TURN_OUTPUT_TOKEN_BUDGET = 80_000;
const DIRECT_TURN_TOTAL_TOKEN_BUDGET = 300_000;
const DIRECT_TURN_BUDGET_WARNING_RATIO = 0.8;
const COMPACT_RECENT_CONVERSATION_TOKEN_BUDGET = 2_000;
const REPEATED_TOOL_FAMILY_LIMIT = 3;

interface StoredSessionConfig {
  init: RuntimeSessionInit;
}

interface PlannedReviewTurnContext {
  taskId: string;
  attempt: number | null;
  workerTaskId: string | null;
  reviewEventId: string | null;
}

interface NormalizedTurnPrompt {
  prompt: string;
  promptContextChars: number;
  compactionContextChars: number;
  feedbackBufferContextChars: number;
  workingMemoryContextChars: number;
  recentConversationChars: number;
  recallContextChars: number;
  inboundMessageChars: number;
}

interface RuntimeSemanticProgressSafetyNet {
  source: "model" | "runtime" | null;
  listId: string;
  title: string;
  lastExecutionLabel: string;
}

function runtimeTurnAbortError(): Error {
  const error = new Error("Runtime turn was cancelled.");
  error.name = "AbortError";
  return error;
}

function goalCompletionIncompleteError(reason: string): Error {
  const error = new Error(reason || "Butler could not complete this turn.");
  error.name = "GoalCompletionIncompleteError";
  return error;
}

function goalCompletionContinuationAttempts(): number {
  const raw = process.env.BUTLER_GOAL_COMPLETION_CONTINUATION_ATTEMPTS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_GOAL_COMPLETION_CONTINUATION_ATTEMPTS;
  return Math.max(0, Math.min(parsed, 100));
}

function directWorkContinuationAttempts(): number {
  const raw = process.env.BUTLER_DIRECT_WORK_CONTINUATION_ATTEMPTS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_DIRECT_WORK_CONTINUATION_ATTEMPTS;
  return Math.max(0, Math.min(parsed, 1_000));
}

interface DirectTurnBudget {
  turnId: string;
  modelRequestsUsed: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxModelCalls: number;
  maxPromptTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
}

function createDirectTurnBudget(turnId: string): DirectTurnBudget {
  return {
    turnId,
    modelRequestsUsed: 0,
    promptTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    maxModelCalls: DIRECT_TURN_MODEL_CALL_BUDGET,
    maxPromptTokens: DIRECT_TURN_PROMPT_TOKEN_BUDGET,
    maxOutputTokens: DIRECT_TURN_OUTPUT_TOKEN_BUDGET,
    maxTotalTokens: DIRECT_TURN_TOTAL_TOKEN_BUDGET,
  };
}

function budgetStatus(budget: DirectTurnBudget): PromptUsageBudgetState["status"] {
  if (
    budget.modelRequestsUsed >= Math.floor(budget.maxModelCalls * DIRECT_TURN_BUDGET_WARNING_RATIO) ||
    budget.promptTokens >= Math.floor(budget.maxPromptTokens * DIRECT_TURN_BUDGET_WARNING_RATIO) ||
    budget.outputTokens >= Math.floor(budget.maxOutputTokens * DIRECT_TURN_BUDGET_WARNING_RATIO) ||
    budget.totalTokens >= Math.floor(budget.maxTotalTokens * DIRECT_TURN_BUDGET_WARNING_RATIO)
  ) {
    return "warning";
  }
  return "ok";
}

function directTurnBudgetState(budget: DirectTurnBudget): PromptUsageBudgetState {
  return {
    status: budgetStatus(budget),
    requestCount: budget.modelRequestsUsed,
    maxRequests: budget.maxModelCalls,
    promptTokens: budget.promptTokens,
    cachedTokens: budget.cachedTokens,
    outputTokens: budget.outputTokens,
    totalTokens: budget.totalTokens,
    maxPromptTokens: budget.maxPromptTokens,
    maxOutputTokens: budget.maxOutputTokens,
    maxTotalTokens: budget.maxTotalTokens,
  };
}

function directToolRoundLimit(requestedRounds: number): number {
  return Math.max(1, Math.min(requestedRounds, DIRECT_TOOL_CHAIN_MAX_ROUNDS));
}

function beforeDirectTurnModelRequest(budget: DirectTurnBudget): void {
  budget.modelRequestsUsed += 1;
}

function addDirectTurnUsage(input: {
  budget: DirectTurnBudget;
  promptTokens: number | null;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number | null;
}): void {
  const promptTokens = typeof input.promptTokens === "number" && Number.isFinite(input.promptTokens)
    ? Math.max(0, input.promptTokens)
    : 0;
  const cachedTokens = Number.isFinite(input.cachedTokens)
    ? Math.max(0, Math.min(input.cachedTokens, promptTokens))
    : 0;
  const outputTokens = Number.isFinite(input.outputTokens) ? Math.max(0, input.outputTokens) : 0;
  const totalTokens = typeof input.totalTokens === "number" && Number.isFinite(input.totalTokens)
    ? Math.max(0, input.totalTokens)
    : promptTokens + outputTokens;
  input.budget.promptTokens += promptTokens;
  input.budget.cachedTokens += cachedTokens;
  input.budget.outputTokens += outputTokens;
  input.budget.totalTokens += totalTokens;
}

function promptUsageSectionsFromPrompt(input: NormalizedTurnPrompt): PromptUsageSectionAttribution[] {
  const sections = [
    ["prompt_context", input.promptContextChars],
    ["compaction_context", input.compactionContextChars],
    ["feedback_buffer", input.feedbackBufferContextChars],
    ["working_memory", input.workingMemoryContextChars],
    ["recent_conversation", input.recentConversationChars],
    ["recall_context", input.recallContextChars],
    ["inbound_message", input.inboundMessageChars],
  ] as const;
  return sections
    .filter(([, chars]) => chars > 0)
    .map(([id, chars]) => ({
      id,
      chars,
      estimatedTokens: estimateContextTokens("x".repeat(Math.min(chars, 200_000))),
    }));
}

export function recentConversationBudgetForTurn(input: {
  configuredBudget: number;
  compactionContext: string;
}): number {
  if (input.compactionContext.trim()) {
    return Math.min(input.configuredBudget, COMPACT_RECENT_CONVERSATION_TOKEN_BUDGET);
  }
  return input.configuredBudget;
}

function repeatedToolFamilyKey(name: string, args: Record<string, unknown>): string | null {
  if (name === "inspect_project_status") return "project-ledger:status";
  if (name === "query_project_work") {
    const kind = typeof args.kind === "string" && args.kind.trim() ? args.kind.trim() : "query";
    return `project-ledger:query:${kind}`;
  }
  if (name === "render_project_dashboard") {
    const view = typeof args.view === "string" && args.view.trim() ? args.view.trim() : "dashboard";
    return `project-ledger:render:${view}`;
  }
  if (name !== "run_command") return null;
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) return null;
  if (/\bproject-ledger\s+status\b/u.test(command)) return "project-ledger:status";
  if (/\bproject-ledger\s+check\b/u.test(command)) return "project-ledger:check";
  const ledgerQuery = command.match(/\bproject-ledger\s+query\b[\s\S]*?\s--kind\s+([A-Za-z0-9._-]+)/u)?.[1];
  if (ledgerQuery) return `project-ledger:query:${ledgerQuery}`;
  if (/^bun\s+test\b/u.test(command)) return "command:test";
  if (/^bun\s+run\s+typecheck\b/u.test(command)) return "command:typecheck";
  if (/^bun\s+run\s+check\b/u.test(command)) return "command:check";
  if (/^git\s+status\b/u.test(command)) return "command:git-status";
  if (/^git\s+diff\b/u.test(command)) return "command:git-diff";
  return null;
}

function isStateMutatingToolCall(name: string, args: Record<string, unknown>): boolean {
  if (name !== "run_command") {
    return ![
      "inspect_project_status",
      "query_project_work",
      "render_project_dashboard",
      "web_search",
      "web_read",
      "read_tool_output_artifact",
      "list_todo_list",
    ].includes(name);
  }
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) return false;
  if (/\b(?:apply_patch|git\s+(?:add|commit|merge|rebase|cherry-pick|rm|mv|tag)|npm\s+(?:install|update)|bun\s+(?:install|add|remove))\b/u.test(command)) {
    return true;
  }
  if (/\b(?:touch|mkdir|rm|mv|cp)\b/u.test(command)) return true;
  if (/\b(?:sed|perl)\s+-i\b/u.test(command)) return true;
  if (/(?:^|[\s;&|])(?:cat|printf|echo)\b[\s\S]*(?:>|>>|\|\s*tee\b)/u.test(command)) return true;
  if (/(?:^|[\s;&|])project-ledger\s+(?:work|task|attempt)\s+(?:create|update|complete|start|succeed|fail)\b/u.test(command)) return true;
  if (/(?:^|[\s;&|])project-ledger\s+render\b[\s\S]*\s--write\b/u.test(command)) return true;
  return false;
}

function repeatedToolFamilyPolicyResult(input: {
  family: string;
  count: number;
  limit: number;
}): Record<string, unknown> {
  return {
    ok: false,
    budget_policy: "repeated_tool_family_blocked",
    repeat_family: input.family,
    repeat_count: input.count,
    repeat_limit: input.limit,
    message:
      "This turn has already repeated this tool family enough times. Reuse the latest evidence, summarize it, or ask for an explicit continuation instead of re-running the same status/test/git command loop.",
  };
}

function throwIfRuntimeTurnAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw runtimeTurnAbortError();
}

function getButlerHome(explicit?: string): string {
  return explicit || process.env.BUTLER_HOME || process.cwd();
}

function getButlerData(explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function transcriptLines(event: TranscriptEvent, butlerData: string): string[] {
  const payload = event.payload as Record<string, any>;
  const message = payload.message as Record<string, any> | undefined;
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachmentContext = renderAttachmentContext(attachments, {
    butlerData,
    title: event.kind === "inbound" ? "User Attachments" : "Butler Attachments",
    includeTextContent: false,
  });
  if (event.kind === "inbound") {
    const text = message?.text;
    return [
      typeof text === "string" && text.trim() ? `user: ${text.trim()}` : "",
      attachmentContext,
    ].filter((line) => line.trim());
  }
  if (event.kind === "outbound") {
    const text = message?.text;
    return [
      typeof text === "string" && text.trim() ? `butler: ${text.trim()}` : "",
      attachmentContext,
    ].filter((line) => line.trim());
  }
  return [];
}

function currentInboundEventId(input: RuntimeTurnInput): string | null {
  if ("text" in input.input) return null;
  return input.input.eventId;
}

function currentRuntimeTurnId(input: RuntimeTurnInput): string | null {
  const metadata = input.metadata && typeof input.metadata === "object"
    ? input.metadata as Record<string, unknown>
    : {};
  return typeof metadata.turnId === "string" && metadata.turnId.trim()
    ? metadata.turnId.trim()
    : currentInboundEventId(input);
}

function plannedReviewTaskIdFromText(text: string): string | null {
  const fromReviewId = text.match(/planned-review:(planned-[A-Za-z0-9._-]+)/u)?.[1];
  if (fromReviewId) return fromReviewId;
  return text.match(/Planned task ID:\s*(planned-[A-Za-z0-9._-]+)/iu)?.[1] ?? null;
}

function plannedReviewAttemptFromText(text: string): number | null {
  const fromEvent = text.match(/system:planned-review:[^:\s]+:attempt-(\d+)/u)?.[1];
  const fromLine = fromEvent ?? text.match(/Attempt:\s*(\d+)/iu)?.[1];
  if (!fromLine) return null;
  const parsed = Number.parseInt(fromLine, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function plannedReviewWorkerTaskIdFromText(text: string): string | null {
  return text.match(/Worker task ID:\s*([A-Za-z0-9._:-]+)/iu)?.[1] ?? null;
}

function plannedReviewEventIdFromText(text: string): string | null {
  const fromEvent = text.match(/system:planned-review:[^:\s]+:attempt-\d+:([A-Za-z0-9._:-]+)/u)?.[1];
  return fromEvent ?? text.match(/Review event ID:\s*([A-Za-z0-9._:-]+)/iu)?.[1] ?? null;
}

function plannedReviewTurnContext(input: RuntimeTurnInput): PlannedReviewTurnContext | null {
  if ("text" in input.input) return null;
  const envelope = input.input;
  const candidates = [
    envelope.eventId,
    envelope.message.id,
    envelope.message.text ?? "",
  ];
  for (const candidate of candidates) {
    const taskId = plannedReviewTaskIdFromText(candidate);
    if (taskId) {
      const joined = candidates.join("\n");
      return {
        taskId,
        attempt: plannedReviewAttemptFromText(joined),
        workerTaskId: plannedReviewWorkerTaskIdFromText(joined),
        reviewEventId: plannedReviewEventIdFromText(joined),
      };
    }
  }
  return null;
}

function metadataRuntimePolicy(metadata: unknown): Record<string, unknown> {
  const record = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  return record.runtimePolicy && typeof record.runtimePolicy === "object"
    ? record.runtimePolicy as Record<string, unknown>
    : {};
}

function metadataPolicyValue(metadata: unknown, key: string): unknown {
  const record = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  const runtimePolicy = metadataRuntimePolicy(metadata);
  return record[key] ?? runtimePolicy[key];
}

function workerModelRulesFromMetadata(metadata: unknown): Array<{
  id?: string;
  label?: string;
  condition?: string;
  model?: string;
  reasoning_effort?: "none" | "low" | "medium" | "high" | "xhigh";
  enabled?: boolean;
}> {
  if (!Array.isArray(metadata)) return [];
  return metadata.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const rule = item as Record<string, unknown>;
    const model = typeof rule.model === "string" ? rule.model.trim() : "";
    if (!model) return [];
    const reasoning = rule.reasoning_effort;
    const reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | undefined =
      reasoning === "none" ||
      reasoning === "low" ||
      reasoning === "medium" ||
      reasoning === "high" ||
      reasoning === "xhigh"
        ? reasoning
        : undefined;
    return [{
      id: typeof rule.id === "string" ? rule.id : undefined,
      label: typeof rule.label === "string" ? rule.label : undefined,
      condition: typeof rule.condition === "string" ? rule.condition : undefined,
      model,
      reasoning_effort: reasoningEffort,
      enabled: rule.enabled === false ? false : true,
    }];
  }).slice(0, 12);
}

function shouldRunGoalCompletionReview(metadata: unknown, role: SessionRole): boolean {
  const value = metadataPolicyValue(metadata, "completionReview");
  if (value === "disabled" || value === false) return false;
  if (value === "enabled" || value === true) return true;
  return role === "butler" || role === "steward";
}

function hasVerifiedEvidenceReceipt(audit: ToolAuditEntry[]): boolean {
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

function hasPendingReadRequirement(audit: ToolAuditEntry[]): boolean {
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

function finalContractFallbackText(language: RuntimeMessageLanguage): string {
  return language === "ko"
    ? "도구 실행 근거가 확인되지 않아 현재 정보는 검증하지 못했습니다."
    : "I could not verify the result because no completed tool evidence was available.";
}

interface OpenDirectWorkBlocker {
  title: string;
  state: string;
  phase: string | null;
  listId: string | null;
  activeItems: Array<{ id: string; label: string; status: string; phase: string | null }>;
}

function finalDeliveryBlockerForOpenDirectWork(input: {
  butlerData: string;
  sessionId: string;
}): OpenDirectWorkBlocker | null {
  const workStream = new WorkStreamStore(input.butlerData).activeForSession(input.sessionId);
  if (!workStream) return null;
  if (
    workStream.linked_planned_task_ids.length > 0 ||
    workStream.linked_orchestration_ids.length > 0 ||
    workStream.linked_worker_task_ids.length > 0
  ) {
    return null;
  }
  if (
    workStream.state === "reporting" ||
    workStream.state === "waiting_user" ||
    workStream.state === "paused" ||
    workStream.state === "recoverable"
  ) {
    return null;
  }
  if (workStream.todo_list_id === RUNTIME_SEMANTIC_TODO_LIST_ID) {
    return null;
  }

  const view = workStream.todo_list_id
    ? new TodoListStore(input.butlerData).view(workStream.todo_list_id, { includeCompleted: true })
    : null;
  const activeItems = view?.list.items
    .filter((item) => item.status === "pending" || item.status === "in_progress")
    .map((item) => ({
      id: item.id,
      label: item.status === "in_progress" ? item.active_form : item.content,
      status: item.status,
      phase: item.phase,
    })) ?? [];

  if (view && activeItems.length === 0) return null;

  return {
    title: workStream.title,
    state: workStream.state,
    phase: workStream.current_phase,
    listId: workStream.todo_list_id,
    activeItems: activeItems.slice(0, 8),
  };
}

function openDirectWorkContinuationPrompt(input: {
  objective: string;
  audit: ToolAuditEntry[];
  blocker: OpenDirectWorkBlocker;
}): string {
  const activeItems = input.blocker.activeItems.length > 0
    ? input.blocker.activeItems
      .map((item, index) =>
        `${index + 1}. [${item.status}${item.phase ? `/${item.phase}` : ""}] ${item.label}`)
      .join("\n")
    : "- Active direct work stream has not reached a deliverable state.";
  const evidence = compactContinuationEvidence(input.audit);
  return [
    "## Direct Work Continuation",
    "Continue the same logical Butler WorkStream as ordinary same-turn progress.",
    "",
    "Current WorkStream:",
    `- title: ${input.blocker.title}`,
    `- state: ${input.blocker.state}`,
    `- phase: ${input.blocker.phase ?? "unknown"}`,
    `- todo_list_id: ${input.blocker.listId ?? "none"}`,
    "",
    "Remaining direct steps:",
    activeItems,
    "",
    "Continuity note:",
    `- objective: ${compactObjectiveText(input.objective, 500)}`,
    ...evidence.map((line) => `- ${line}`),
    "",
    "Next action:",
    "- Use the structured tool-call channel to execute the remaining direct work or to move the WorkStream to a legitimate deliverable state.",
    "- Update `update_todo_list` as evidence is gathered and steps complete.",
    "- Keep the response focused on the remaining work and evidence, without meta-narrating runtime control flow.",
    "- Do not answer with a promise, plan, or 'I will start now' message.",
    "- Final delivery is allowed only after the direct WorkStream has no unfinished active items, reaches reporting/waiting_user/paused/recoverable with evidence, or is linked to an async worker/planned/orchestration stream.",
  ].join("\n");
}

function compactContinuationText(value: string, maxChars: number, fallback = ""): string {
  const normalized = sanitizePublicText(value, "").replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}...`;
}

function compactObjectiveText(value: string, maxChars: number): string {
  return compactContinuationText(value, maxChars, "same user request");
}

function compactContinuationEvidence(audit: ToolAuditEntry[]): string[] {
  const recent = audit
    .filter((entry) => entry.ok)
    .slice(-6);
  if (recent.length === 0) return ["recent evidence: none yet"];
  return recent.map((entry, index) => {
    const receipts = (entry.evidenceReceipts ?? [])
      .map((receipt) =>
        compactContinuationText(receipt.summary, 120) ||
        compactContinuationText(receipt.receiptType, 120))
      .filter(Boolean)
      .slice(0, 2);
    const receiptText = receipts.length > 0 ? `; receipts: ${receipts.join(" | ")}` : "";
    return `evidence ${index + 1}: ${entry.name}${receiptText}`;
  });
}

function stableJsonForCache(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
  ));
}

function hasGoalCompletionReviewSkipTool(audit: ToolAuditEntry[]): boolean {
  return audit.some((entry) => entry.ok && GOAL_COMPLETION_REVIEW_SKIP_TOOLS.has(entry.name));
}

function completeReportingWorkStreamBestEffort(input: {
  butlerData: string;
  sessionId: string;
}): void {
  try {
    const completed = completeTurnLocalWorkStreamForSession({
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      statusNote: "Final answer delivered.",
    });
    if (!completed) {
      completeReportingWorkStreamForSession({
        butlerData: input.butlerData,
        sessionId: input.sessionId,
        statusNote: "Final answer delivered.",
      });
    }
  } catch {
    // Final WorkStream bookkeeping must not block final answer delivery.
  }
}

function completeRuntimeSemanticWorkStreamBestEffort(input: {
  butlerData: string;
  sessionId: string;
  projectId?: string;
  tracker: RuntimeSemanticProgressSafetyNet;
  language: RuntimeMessageLanguage;
}): void {
  if (input.tracker.source !== "runtime") return;
  try {
    const todoView = new TodoListStore(input.butlerData).update({
      listId: input.tracker.listId,
      title: input.tracker.title,
      items: runtimeSemanticTodoItems({
        language: input.language,
        executionLabel: input.tracker.lastExecutionLabel,
        state: "complete",
      }),
    });
    new WorkStreamStore(input.butlerData).updateFromTodoList({
      ownerSessionId: input.sessionId,
      projectId: input.projectId,
      listId: input.tracker.listId,
      title: todoView.list.title ?? input.tracker.title,
      items: todoView.list.items,
    });
  } catch {
    // Synthetic progress bookkeeping must never block final delivery.
  }
}

function markActiveWorkStreamRecoverableBestEffort(input: {
  butlerData: string;
  sessionId: string;
  reason?: string;
}): void {
  try {
    const store = new WorkStreamStore(input.butlerData);
    const record = store.activeForSession(input.sessionId);
    if (!record || workStreamTerminal(record.state) || record.state === "recoverable") return;
    const reason = safeTextForStatusNote(input.reason);
    store.transition({
      id: record.id,
      state: "recoverable",
      statusNote: reason
        ? `Turn interrupted before final delivery; durable work can be resumed. Cause: ${reason}`
        : "Turn interrupted before final delivery; durable work can be resumed.",
    });
  } catch {
    // Recovery bookkeeping must not hide the original runtime failure.
  }
}

function safeTextForStatusNote(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function buildRecentConversation(input: RuntimeTurnInput, maxTokens: number, butlerData: string): string {
  const currentEventId = currentInboundEventId(input);
  const lines = readTranscript(input.handle.sessionId)
    .filter((event) => event.eventId !== currentEventId && (event.payload as Record<string, any>)?.eventId !== currentEventId)
    .flatMap((event) => transcriptLines(event, butlerData))
    .filter((line) => line.trim());

  const selected = takeLinesFromEndWithinBudget(lines, maxTokens);
  if (selected.length === 0) return "";
  return ["## Recent Conversation", ...selected].join("\n");
}

function normalizeTurnPrompt(input: RuntimeTurnInput, options: {
  recallContext?: string;
  compactionContext?: string;
  feedbackBufferContext?: string;
  workingMemoryContext?: string;
  runtimePolicyContext?: string;
  recentConversationTokenBudget: number;
  butlerData: string;
}): NormalizedTurnPrompt {
  const parts: string[] = [];
  const rawPromptContext =
    typeof input.metadata?.promptContext === "string" ? input.metadata.promptContext.trim() : "";
  const structuredCurrentText = metadataCurrentUserText(input);
  const promptContext = structuredCurrentText
    ? removePromptContextSection(rawPromptContext, "Current User Input")
    : rawPromptContext;
  if (promptContext) {
    parts.push(promptContext);
  }

  const compactionContext = options.compactionContext?.trim() ?? "";
  if (compactionContext) {
    parts.push(compactionContext);
  }

  const feedbackBufferContext = options.feedbackBufferContext?.trim() ?? "";
  if (feedbackBufferContext) {
    parts.push(feedbackBufferContext);
  }

  const workingMemoryContext = options.workingMemoryContext?.trim() ?? "";
  if (workingMemoryContext) {
    parts.push(workingMemoryContext);
  }

  const recentConversation = buildRecentConversation(input, options.recentConversationTokenBudget, options.butlerData);
  if (recentConversation) {
    parts.push(recentConversation);
  }

  const recallContext = options.recallContext?.trim() ?? "";
  if (recallContext) {
    parts.push(recallContext);
  }

  const runtimePolicyContext = options.runtimePolicyContext?.trim() ?? "";
  if (runtimePolicyContext) {
    parts.push(runtimePolicyContext);
  }

  let inboundMessageChars: number;
  const promptContextHasCurrentInput = promptContextIncludesSection(input, "Current User Input");
  if ("text" in input.input) {
    const text = structuredCurrentText || input.input.text?.trim() || "";
    inboundMessageChars = text.length;
    if (structuredCurrentText || !promptContextHasCurrentInput) {
      parts.push("## Inbound Message");
      parts.push(`Message Text: ${text}`);
    }
  } else {
    const envelope = input.input as InboundEnvelope;
    const text = structuredCurrentText || envelope.message.text?.trim() || "";
    inboundMessageChars = text.length;
    if (structuredCurrentText || !promptContextHasCurrentInput) {
      parts.push("## Inbound Message");
      parts.push(`Transport: ${envelope.transport}`);
      parts.push(`Sender ID: ${envelope.sender.id}`);
      if (envelope.sender.displayName) {
        parts.push(`Sender Name: ${envelope.sender.displayName}`);
      }
      parts.push(`Message ID: ${envelope.message.id}`);
      parts.push(`Message Timestamp: ${envelope.message.timestamp}`);
      parts.push(`Message Text: ${text}`);
    }
  }

  const prompt = parts.filter(Boolean).join("\n");
  return {
    prompt,
    promptContextChars: promptContext.length,
    compactionContextChars: compactionContext.length,
    feedbackBufferContextChars: feedbackBufferContext.length,
    workingMemoryContextChars: workingMemoryContext.length,
    recentConversationChars: recentConversation.length,
    recallContextChars: recallContext.length,
    inboundMessageChars,
  };
}

function removePromptContextSection(promptContext: string, title: string): string {
  if (!promptContext.trim()) return "";
  const section = new RegExp(`(?:^|\\n)## ${escapeRegExp(title)}\\n[\\s\\S]*?(?=\\n## |$)`, "u");
  return promptContext.replace(section, "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inboundText(input: RuntimeTurnInput): string {
  if ("text" in input.input) return input.input.text?.trim() || "";
  return input.input.message.text?.trim() || "";
}

function metadataCurrentUserText(input: RuntimeTurnInput): string {
  return typeof input.metadata?.currentUserText === "string"
    ? input.metadata.currentUserText.trim()
    : "";
}

function currentUserText(input: RuntimeTurnInput): string {
  return metadataCurrentUserText(input) || inboundText(input);
}

function inboundAttachments(input: RuntimeTurnInput): AttachmentRef[] {
  if ("text" in input.input) return [];
  return Array.isArray(input.input.message.attachments)
    ? input.input.message.attachments
    : [];
}

function promptContextIncludesSection(input: RuntimeTurnInput, title: string): boolean {
  const promptContext =
    typeof input.metadata?.promptContext === "string" ? input.metadata.promptContext : "";
  return promptContext.includes(`## ${title}`);
}

function shouldAttemptAutomaticRecall(input: RuntimeTurnInput, text: string): boolean {
  if (!text.trim()) return false;
  if (input.metadata?.automaticRecall === false) return false;
  if (input.metadata?.transport === "system" || input.metadata?.eventKind === "system") return false;
  if (!("text" in input.input) && input.input.transport === "system") return false;
  return text.trim().length >= 4;
}

function renderRecallContext(result: AssociativeRecallResult): string {
  if (result.abstained || result.items.length === 0) return "";
  const lines = [
    "## Associative Recall Context",
    "Use this compact memory only when it helps answer the current message. Do not expose scores unless asked.",
  ];
  for (const item of result.items.slice(0, 4)) {
    const provenance = item.provenance.slice(0, 2).join(", ");
    lines.push(`- ${item.summary} (confidence=${item.confidence.toFixed(2)}, source=${item.source}, provenance=${provenance})`);
  }
  return lines.join("\n");
}

function recordIntentGuardMetric(input: {
  butlerData: string;
  role: string;
  runtime: string;
  model: string;
  guard: RuntimeIntentGuardName;
  detail: string;
}): void {
  recordOperationalMetric({
    category: "runtime",
    name: "intent_guard",
    status: "ok",
    dimensions: {
      role: input.role,
      runtime: input.runtime,
      model: input.model,
      guard: input.guard,
      detail: input.detail,
    },
  }, { butlerData: input.butlerData });
}

function peerForOutbound(envelope: InboundEnvelope): OutboundAction["peer"] {
  if (envelope.peer.kind === "thread") {
    return {
      kind: "thread",
      id: envelope.peer.parentId ?? envelope.peer.id,
      threadId: envelope.peer.id,
    };
  }
  return {
    kind: envelope.peer.kind,
    id: envelope.peer.id,
  };
}

function buildIntermediateAction(input: {
  envelope: InboundEnvelope;
  suffix: string;
  text: string;
  metadata?: Record<string, unknown>;
}): OutboundAction {
  return {
    actionId: `runtime-intermediate:${input.envelope.eventId}:${input.suffix}`,
    transport: input.envelope.transport,
    accountId: input.envelope.accountId,
    peer: peerForOutbound(input.envelope),
    message: {
      text: input.text,
      replyToMessageId: input.envelope.message.id,
    },
    metadata: {
      source: "runtime/native-tool-loop.ts",
      kind: "intermediate",
      ...input.metadata,
    },
  };
}

function taskIdFromToolResult(result: unknown): string | null {
  const output = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return typeof output.task_id === "string"
    ? output.task_id
    : typeof output.taskId === "string"
      ? output.taskId
      : null;
}

function publicReportFromToolOutput(output: unknown): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const report = (output as Record<string, unknown>).report;
  return typeof report === "string" && report.trim() ? report.trim() : null;
}

function plannedReviewTerminalToolText(input: {
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

function isInternalProgressTool(name: string): boolean {
  return INTERNAL_PROGRESS_TOOLS.has(name);
}

function discardPendingPublicDecisionForTool(
  pending: PublicWorkDecision[],
  toolName: string,
): void {
  const index = pending.findIndex((decision) => decision.toolName === toolName);
  if (index >= 0) pending.splice(index, 1);
}

function todoProgressItemsFromArgs(args: Record<string, unknown>): Array<{
  id: string;
  label: string;
  state: string;
  phase: string | null;
  order: number;
}> {
  const todos = Array.isArray(args.todos) ? args.todos : [];
  return todos
    .filter((todo): todo is Record<string, unknown> =>
      Boolean(todo && typeof todo === "object" && !Array.isArray(todo)))
    .map((todo, index) => {
      const rawStatus = typeof todo.status === "string" ? todo.status : "pending";
      const status = rawStatus === "in_progress" ||
        rawStatus === "completed" ||
        rawStatus === "cancelled"
        ? rawStatus
        : "pending";
      const preferredLabel = status === "in_progress"
        ? todo.active_form ?? todo.content
        : todo.content ?? todo.active_form;
      const label = sanitizePublicText(preferredLabel, "").trim();
      const rawId = typeof todo.id === "string" && todo.id.trim()
        ? todo.id.trim()
        : `todo-${index + 1}`;
      return {
        id: sanitizePublicText(rawId, `todo-${index + 1}`).replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 64) || `todo-${index + 1}`,
        label,
        state: todoProgressState(status),
        phase: todoProgressPhase(todo.phase),
        order: index + 1,
      };
    })
    .filter((item) => item.label)
    .slice(0, 8);
}

function todoProgressPhase(value: unknown): string | null {
  if (
    value === "conception" ||
    value === "planning" ||
    value === "execution" ||
    value === "review" ||
    value === "consolidation" ||
    value === "reporting"
  ) {
    return value;
  }
  return null;
}

function todoProgressState(status: string): string {
  if (status === "in_progress") return "running";
  if (status === "completed") return "delivered";
  if (status === "cancelled") return "cancelled";
  return "accepted";
}

function runtimeSemanticTodoItems(input: {
  language: RuntimeMessageLanguage;
  executionLabel: string;
  state: "execution" | "review" | "complete";
}): TodoItemInput[] {
  const ko = input.language === "ko";
  const executionLabel =
    sanitizePublicText(
      input.executionLabel,
      ko ? "필요한 도구 작업을 실행합니다." : "Run the needed tool work.",
    ).slice(0, 180) || (ko ? "필요한 도구 작업을 실행합니다." : "Run the needed tool work.");
  const status = (phase: TodoItemInput["phase"]): TodoItemInput["status"] => {
    if (input.state === "complete") return "completed";
    if (phase === "execution") return input.state === "execution" ? "in_progress" : "completed";
    if (phase === "review") return input.state === "review" ? "in_progress" : "pending";
    if (phase === "conception" || phase === "planning") return "completed";
    return "pending";
  };
  return [
    {
      id: "orient",
      content: ko ? "요청 의도 확인" : "Understand the request",
      active_form: ko ? "요청 의도를 확인합니다." : "Understanding the request.",
      status: status("conception"),
      phase: "conception",
    },
    {
      id: "plan",
      content: ko ? "확인 경로 준비" : "Prepare the evidence path",
      active_form: ko ? "확인 경로를 준비합니다." : "Preparing the evidence path.",
      status: status("planning"),
      phase: "planning",
    },
    {
      id: "execute",
      content: executionLabel,
      active_form: executionLabel,
      status: status("execution"),
      phase: "execution",
    },
    {
      id: "review",
      content: ko ? "도구 결과 검토" : "Review tool evidence",
      active_form: ko ? "도구 결과를 검토합니다." : "Reviewing tool evidence.",
      status: status("review"),
      phase: "review",
    },
    {
      id: "consolidate",
      content: ko ? "핵심 결과 정리" : "Consolidate the result",
      active_form: ko ? "핵심 결과를 정리합니다." : "Consolidating the result.",
      status: input.state === "complete" ? "completed" : "pending",
      phase: "consolidation",
    },
    {
      id: "report",
      content: ko ? "사용자에게 보고" : "Report to the user",
      active_form: ko ? "사용자에게 보고합니다." : "Reporting to the user.",
      status: input.state === "complete" ? "completed" : "pending",
      phase: "reporting",
    },
  ];
}

function activeTodoWorkBlockFromArgs(args: Record<string, unknown>): { id: string; label: string } | null {
  const active = todoProgressItemsFromArgs(args).find((item) => item.state === "running");
  if (!active) return null;
  return {
    id: `work-todo-${active.id}`,
    label: active.label,
  };
}

async function emitTodoProgressBestEffort(input: {
  turnInput: RuntimeTurnInput;
  args: Record<string, unknown>;
}): Promise<void> {
  const inboundEnvelope = "eventId" in input.turnInput.input ? input.turnInput.input : null;
  if (!inboundEnvelope || !input.turnInput.emitIntermediateDelivery) return;
  const items = todoProgressItemsFromArgs(input.args);
  for (const item of items) {
    await emitIntermediateBestEffort(
      input.turnInput,
      buildIntermediateAction({
        envelope: inboundEnvelope,
        suffix: `todo-progress-${item.id}-${randomUUID().slice(0, 8)}`,
        text: "",
        metadata: {
          kind: "todo_progress",
          todoId: item.id,
          safeLabel: item.label,
          state: item.state,
          safeOrder: item.order,
          ...(item.phase ? { phase: item.phase } : {}),
        },
      }),
      {
        source: "runtime/native-tool-loop.ts#todo-progress",
        kind: "todo_progress",
        todoId: item.id,
        safeLabel: item.label,
        state: item.state,
        safeOrder: item.order,
        ...(item.phase ? { phase: item.phase } : {}),
      },
    );
  }
}

async function emitDecisionProgressBestEffort(input: {
  turnInput: RuntimeTurnInput;
  decision: PublicWorkDecision;
  state: string;
}): Promise<void> {
  const inboundEnvelope = "eventId" in input.turnInput.input ? input.turnInput.input : null;
  if (!inboundEnvelope || !input.turnInput.emitIntermediateDelivery) return;
  await emitIntermediateBestEffort(
    input.turnInput,
    buildIntermediateAction({
      envelope: inboundEnvelope,
      suffix: `decision-progress-${input.decision.decisionId}-${input.state}`,
      text: "",
      metadata: {
        kind: "todo_progress",
        todoId: input.decision.decisionId,
        safeLabel: input.decision.summary,
        state: input.state,
      },
    }),
    {
      source: "runtime/native-tool-loop.ts#decision-progress",
      kind: "todo_progress",
      todoId: input.decision.decisionId,
      safeLabel: input.decision.summary,
      state: input.state,
    },
  );
}

function shouldSynthesizeRuntimeSemanticProgress(input: {
  callName: string;
  args: Record<string, unknown>;
}): boolean {
  if (isInternalProgressTool(input.callName)) return false;
  if (WORKER_ORCHESTRATION_START_TOOL_SET.has(input.callName)) return false;
  if (input.callName !== "run_command") return false;
  const command = typeof input.args.command === "string" ? input.args.command : "";
  return /[;&|]|\n/u.test(command);
}

function compactForComparison(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function leaksInternalExecutionPlan(input: {
  text: string;
  rawTasks: string[];
}): boolean {
  const text = compactForComparison(input.text);
  if (!text) return true;
  if (text.length > 700) return true;
  if (/\btask[_ -]?id\b/i.test(input.text)) return true;
  if (/dispatch_worker|resume_worker/i.test(input.text)) return true;
  for (const rawTask of input.rawTasks) {
    const task = compactForComparison(rawTask);
    if (task.length >= 40 && text.includes(task.slice(0, 40))) return true;
  }
  return false;
}

async function emitAssistantTextBeforeTools(input: {
  turnInput: RuntimeTurnInput;
  text: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  language: RuntimeMessageLanguage;
}): Promise<void> {
  const inboundEnvelope = "eventId" in input.turnInput.input ? input.turnInput.input : null;
  if (!inboundEnvelope || !input.turnInput.emitIntermediateDelivery) return;
  const workerStartCalls = input.toolCalls.filter((call) =>
    call.name === "dispatch_worker" || call.name === "resume_worker",
  );
  if (workerStartCalls.length === 0) return;

  const rawTasks = workerStartCalls
    .map((call) => typeof call.args.task === "string" ? call.args.task : "")
    .filter((task) => task.trim());
  const planText = leaksInternalExecutionPlan({
    text: input.text,
    rawTasks,
  })
    ? ""
    : input.text.trim();
  if (!planText) return;

  await emitIntermediateBestEffort(
    input.turnInput,
    buildIntermediateAction({
      envelope: inboundEnvelope,
      suffix: `${workerStartCalls.map((call) => call.name).join("-")}-start`,
      text: planText,
      metadata: {
        tool: workerStartCalls.map((call) => call.name).join(","),
        phase: "before_tool_execution",
      },
    }),
    {
      source: "runtime/native-tool-loop.ts#assistant-plan",
      tool: workerStartCalls.map((call) => call.name).join(","),
    },
  );
}

async function emitIntermediateBestEffort(
  input: RuntimeTurnInput,
  action: OutboundAction,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await input.emitIntermediateDelivery?.(action, metadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: input.handle.sessionId,
      kind: "system",
      payload: {
        category: "intermediate_delivery_error",
        message,
        actionId: action.actionId,
      },
      metadata: {
        source: "runtime/native-tool-loop.ts",
      },
    }));
  }
}

async function emitTurnEventBestEffort(
  input: RuntimeTurnInput,
  event: RuntimeTurnEventInput,
): Promise<void> {
  try {
    await input.emitTurnEvent?.(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: input.handle.sessionId,
      kind: "system",
      payload: {
        category: "turn_event_delivery_error",
        message,
        kind: (event as { kind?: unknown }).kind ?? null,
      },
      metadata: {
        source: "runtime/native-tool-loop.ts",
      },
    }));
  }
}

const MAX_RUNTIME_ARTIFACT_REFS = 12;

function runtimeArtifactsFromAudit(input: {
  audit: ToolAuditEntry[];
  butlerData: string;
  workspacePath: string;
}): ArtifactRef[] {
  const artifacts: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const entry of input.audit) {
    if (!entry.ok || !isRecord(entry.result)) continue;
    collectVerifiedOutputArtifacts({
      artifacts,
      seen,
      result: entry.result,
      butlerData: input.butlerData,
      workspacePath: input.workspacePath,
    });
    collectPublicDataArtifacts({
      artifacts,
      seen,
      result: entry.result,
      butlerData: input.butlerData,
    });
    if (artifacts.length >= MAX_RUNTIME_ARTIFACT_REFS) break;
  }
  return artifacts.slice(0, MAX_RUNTIME_ARTIFACT_REFS);
}

function collectVerifiedOutputArtifacts(input: {
  artifacts: ArtifactRef[];
  seen: Set<string>;
  result: Record<string, unknown>;
  butlerData: string;
  workspacePath: string;
}): void {
  const verified = Array.isArray(input.result.verified_output_files)
    ? input.result.verified_output_files
    : [];
  const cwd = typeof input.result.cwd === "string" && input.result.cwd.trim()
    ? input.result.cwd.trim()
    : input.workspacePath;
  for (const [index, item] of verified.entries()) {
    if (input.artifacts.length >= MAX_RUNTIME_ARTIFACT_REFS) return;
    if (!isRecord(item) || typeof item.path !== "string" || !item.path.trim()) continue;
    const safePathLabel = item.path.trim();
    const localPath = resolveVerifiedArtifactPath({
      cwd,
      butlerData: input.butlerData,
      workspacePath: input.workspacePath,
      safePathLabel,
    });
    if (!localPath) continue;
    appendRuntimeArtifact(input.artifacts, input.seen, {
      id: `artifact-${safeIdentifier(safePathLabel)}-${index + 1}`,
      kind: artifactKindFromValue(item.artifact_kind, localPath),
      title: basename(safePathLabel) || "Artifact",
      safePathLabel,
      localPath,
      mimeType: mimeTypeForPath(localPath),
      sizeBytes: numberValue(item.size_bytes) ?? fileSize(localPath),
      createdAt: typeof item.modified_at === "string" ? item.modified_at : undefined,
    });
  }
}

function collectPublicDataArtifacts(input: {
  artifacts: ArtifactRef[];
  seen: Set<string>;
  result: Record<string, unknown>;
  butlerData: string;
}): void {
  const labels = stringList(input.result.artifact_labels ?? input.result.artifact_label);
  if (labels.length === 0) return;
  const kinds = stringList(input.result.artifact_kinds ?? input.result.artifact_kind);
  const artifactId = typeof input.result.artifact_id === "string" && input.result.artifact_id.trim()
    ? input.result.artifact_id.trim()
    : null;
  const publicDataRoot = join(input.butlerData, "artifacts", "public-data");
  for (const [index, label] of labels.entries()) {
    if (input.artifacts.length >= MAX_RUNTIME_ARTIFACT_REFS) return;
    const localPath = resolveUnderRoot(publicDataRoot, label);
    if (!localPath || !existsSync(localPath)) continue;
    const title = typeof input.result.title === "string" && input.result.title.trim()
      ? input.result.title.trim()
      : basename(label);
    appendRuntimeArtifact(input.artifacts, input.seen, {
      id: labels.length === 1 && artifactId
        ? artifactId
        : `artifact-${artifactId ?? safeIdentifier(label)}-${index + 1}`,
      kind: artifactKindFromValue(kinds[index] ?? kinds[0], localPath),
      title,
      safePathLabel: label,
      localPath,
      mimeType: mimeTypeForPath(localPath),
      sizeBytes: fileSize(localPath),
    });
  }
}

function appendRuntimeArtifact(
  artifacts: ArtifactRef[],
  seen: Set<string>,
  artifact: ArtifactRef,
): void {
  const key = artifact.localPath
    ? `path:${resolve(artifact.localPath)}`
    : `id:${artifact.id}:${artifact.safePathLabel ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  artifacts.push(artifact);
}

function resolveVerifiedArtifactPath(input: {
  cwd: string;
  butlerData: string;
  workspacePath: string;
  safePathLabel: string;
}): string | null {
  const cwd = resolve(input.cwd);
  const workspace = resolve(input.workspacePath);
  const candidate = resolve(cwd, input.safePathLabel);
  if (isPathInsideRoot(candidate, workspace) && existsSync(candidate)) {
    return candidate;
  }
  if (!input.safePathLabel.startsWith("artifacts/")) return null;
  const dataCandidate = resolveUnderRoot(input.butlerData, input.safePathLabel);
  return dataCandidate && existsSync(dataCandidate) ? dataCandidate : null;
}

function resolveUnderRoot(root: string, child: string): string | null {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, child);
  return isPathInsideRoot(candidate, resolvedRoot) ? candidate : null;
}

function isPathInsideRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

function artifactKindFromValue(value: unknown, localPath?: string): ArtifactRef["kind"] {
  if (
    value === "csv_file" ||
    value === "table_file" ||
    value === "chart_file" ||
    value === "image" ||
    value === "document" ||
    value === "code" ||
    value === "report" ||
    value === "file"
  ) {
    return value;
  }
  const ext = localPath ? extname(localPath).toLocaleLowerCase("en-US") : "";
  if (ext === ".csv") return "csv_file";
  if (ext === ".tsv") return "table_file";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext)) return "image";
  if (ext === ".pdf") return "report";
  if ([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt"].includes(ext)) return "code";
  if ([".md", ".txt", ".json", ".html"].includes(ext)) return "document";
  return "file";
}

function mimeTypeForPath(path: string): string {
  const ext = extname(path).toLocaleLowerCase("en-US");
  if (ext === ".csv") return "text/csv";
  if (ext === ".tsv") return "text/tab-separated-values";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".json") return "application/json";
  if (ext === ".html") return "text/html";
  if (ext === ".md" || ext === ".txt") return "text/plain";
  return "application/octet-stream";
}

function fileSize(path: string): number | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/-+/gu, "-").slice(0, 48) || "artifact";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function completedToolProgressSummary(
  progress: ToolProgressSummary,
  result: unknown,
): ToolProgressSummary {
  if (progress.toolName !== "Web search") return progress;
  const plannedQueries = smartSearchPlannedQueries(result);
  if (plannedQueries.length === 0) return progress;
  const count = plannedQueries.length;
  const countLabel = `${count} planned ${count === 1 ? "query" : "queries"}`;
  return {
    ...progress,
    safeLabel: `Smart web search: ${countLabel}`,
    inputLabel: countLabel,
    detailRows: plannedQueries.map((query, index) => ({
      id: `web-search-planned-query-${index + 1}`,
      kind: "query",
      safe_label: `Planned query ${index + 1}`,
      safe_value: query,
      state: "delivered",
    })),
  };
}

function smartSearchPlannedQueries(result: unknown): string[] {
  if (!isRecord(result)) return [];
  const plan = result.search_plan;
  if (!isRecord(plan) || plan.mode !== "smart") return [];
  const queries = plan.queries;
  if (!Array.isArray(queries)) return [];
  return queries
    .map((item) => {
      if (!isRecord(item)) return "";
      return typeof item.query === "string"
        ? sanitizePublicText(item.query, "planned query").slice(0, 220)
        : "";
    })
    .filter((query) => query && query !== "planned query")
    .slice(0, 8);
}

export class NativeToolLoopRuntime implements AgentRuntimeAdapter {
  readonly id = "native-tool-loop";

  readonly capabilities = {
    supportsSessionResume: false,
    supportsCompaction: false,
    supportsToolStreaming: false,
    supportsParallelToolCalls: false,
  } as const;

  private readonly sessions = new Map<string, StoredSessionConfig>();
  private readonly promptRunner: typeof runPromptText;
  private readonly toolPromptRunner: typeof runFunctionToolPromptText;
  private readonly butlerToolExecutor?: FunctionToolPromptOptions["executeTool"];
  private readonly butlerHome: string;
  private readonly butlerData: string;
  private readonly appMessageDbPath?: string;
  private readonly messageLanguage: RuntimeMessageLanguage;
  private readonly recallRunner?: typeof recallMemory;
  private readonly vectorRecallRunner: typeof recallMemoryWithVector;
  private readonly automaticRecallEnabled: boolean;
  private readonly contextBudgetOverrides?: ContextBudgetOverrides;
  private readonly recentConversationTokenBudget?: number;

  constructor(options: NativeToolLoopRuntimeOptions = {}) {
    this.promptRunner = options.runPromptText ?? runPromptText;
    this.toolPromptRunner = options.runFunctionToolPromptText ?? runFunctionToolPromptText;
    this.butlerToolExecutor = options.executeButlerTool;
    this.butlerHome = getButlerHome(options.butlerHome);
    this.butlerData = getButlerData(options.butlerData);
    this.appMessageDbPath = options.appMessageDbPath;
    this.messageLanguage = options.messageLanguage ?? resolveRuntimeMessageLanguage({
      butlerData: this.butlerData,
    });
    this.recallRunner = options.recallMemory;
    this.vectorRecallRunner = options.recallMemoryWithVector ?? recallMemoryWithVector;
    this.automaticRecallEnabled = options.disableAutomaticRecall !== true;
    this.contextBudgetOverrides = options.contextBudgetOverrides;
    this.recentConversationTokenBudget = options.recentConversationTokenBudget;
  }

  async createSession(input: RuntimeSessionInit): Promise<RuntimeSessionHandle> {
    this.sessions.set(input.sessionId, {
      init: input,
    });

    return {
      sessionId: input.sessionId,
      role: input.role,
      runtimeAdapterId: this.id,
      runtimeSessionRef: `native:${input.sessionId}:${randomUUID()}`,
    };
  }

  private async runAutomaticRecall(input: {
    butlerData: string;
    cue: string;
    projectId?: string;
    limit?: number;
  }): Promise<AssociativeRecallResult> {
    if (this.recallRunner) return this.recallRunner(input);
    return await this.vectorRecallRunner({
      ...input,
      vectorTimeoutMs: AUTOMATIC_RECALL_VECTOR_TIMEOUT_MS,
    });
  }

  async runTurn(input: RuntimeTurnInput): Promise<RuntimeTurnResult> {
    const startedAt = Date.now();
    throwIfRuntimeTurnAborted(input.signal);
    const session = this.sessions.get(input.handle.sessionId);
    if (!session) {
      recordOperationalMetric({
        category: "runtime",
        name: "turn",
        status: "error",
        durationMs: Date.now() - startedAt,
        dimensions: {
          role: input.handle.role,
          runtime: this.id,
          model: input.model,
          errorName: "MissingSession",
        },
      }, { butlerData: this.butlerData });
      throw new Error(`NativeToolLoopRuntime has no stored session for ${input.handle.sessionId}`);
    }

    const useTools = session.init.role === "butler" || session.init.role === "steward";

    try {
      throwIfRuntimeTurnAborted(input.signal);
      const audit: ToolAuditEntry[] = [];
      const publicDecisionContext: PublicWorkDecision[] = [];
      const pendingPublicDecisions: PublicWorkDecision[] = [];
      const semanticProgressSafetyNet: RuntimeSemanticProgressSafetyNet = {
        source: null,
        listId: RUNTIME_SEMANTIC_TODO_LIST_ID,
        title: this.messageLanguage === "ko" ? "진행 중인 작업" : "Current work",
        lastExecutionLabel: this.messageLanguage === "ko"
          ? "필요한 도구 작업을 실행합니다."
          : "Run the needed tool work.",
      };
      const userText = currentUserText(input);
      const plannedReview = plannedReviewTurnContext(input);
      let recallContext = "";
      try {
        await maybeAutoCompactSession({
          butlerData: this.butlerData,
          sessionId: input.handle.sessionId,
          modelRef: input.model,
          budgetOverrides: this.contextBudgetOverrides,
        });
      } catch {
        // Compaction is a safety optimization; it must not block the active turn.
      }

      if (this.automaticRecallEnabled && shouldAttemptAutomaticRecall(input, userText)) {
        try {
          recallContext = renderRecallContext(await this.runAutomaticRecall({
            butlerData: this.butlerData,
            cue: userText,
            projectId: typeof session.init.metadata?.projectId === "string" ? session.init.metadata.projectId : undefined,
            limit: 4,
          }));
        } catch {
          recallContext = "";
        }
      }
      const compactionContext = renderCompactionContext(readLatestCompactionSnapshot({
        butlerData: this.butlerData,
        sessionId: input.handle.sessionId,
      }));
      const turnId = currentRuntimeTurnId(input) ?? `turn-${randomUUID().slice(0, 12)}`;
      const turnBudget = createDirectTurnBudget(turnId);
      const feedbackBufferContext = promptContextIncludesSection(input, "Active Feedback Buffer")
        ? ""
        : renderFeedbackBufferContext({
          butlerData: this.butlerData,
          sessionId: input.handle.sessionId,
        });
      const workingMemoryContext = renderWorkingMemoryContext(refreshWorkingMemoryFromTranscript({
        butlerData: this.butlerData,
        sessionId: input.handle.sessionId,
        excludeEventId: currentInboundEventId(input),
      }));
      const runtimePolicyContext = renderSessionContextPolicyContext({
        catalog: loadSessionContextPolicyCatalog(this.butlerHome),
        session: session.init,
      });
      const normalizedPrompt = normalizeTurnPrompt(input, {
        recallContext,
        compactionContext,
        feedbackBufferContext,
        workingMemoryContext,
        runtimePolicyContext,
        recentConversationTokenBudget: recentConversationBudgetForTurn({
          configuredBudget: this.recentConversationTokenBudget ?? defaultRecentConversationTokenBudget(input.model),
          compactionContext,
        }),
        butlerData: this.butlerData,
      });
      const promptSections = promptUsageSectionsFromPrompt(normalizedPrompt);
      await emitTurnEventBestEffort(input, {
        kind: "turn.iteration.started",
        payload: {
          iteration: 1,
          model: input.model,
          useTools,
          turnId,
          budget: directTurnBudgetState(turnBudget),
        },
      });
      const prompt = normalizedPrompt.prompt;
      const attachments = inboundAttachments(input);
      const currentAttachmentContext = renderAttachmentContext(attachments, {
        butlerData: this.butlerData,
        title: "Inbound Attachments",
        maxAttachmentTextChars: 18_000,
        maxTotalTextChars: 36_000,
      });
      const executor = createAuditedButlerToolExecutor({
        sessionId: input.handle.sessionId,
        audit,
        publicDecisionContext,
        pendingPublicDecisions,
        turnInput: input,
        butlerData: this.butlerData,
        messageLanguage: this.messageLanguage,
        plannedReview,
        semanticProgressSafetyNet,
        executor: this.butlerToolExecutor ?? createButlerToolExecutor({
          butlerHome: this.butlerHome,
          butlerData: this.butlerData,
          appMessageDbPath: this.appMessageDbPath,
          workspacePath: session.init.workspacePath,
          sessionId: input.handle.sessionId,
          projectId: typeof session.init.metadata?.projectId === "string" ? session.init.metadata.projectId : undefined,
          turnId: currentRuntimeTurnId(input) ?? undefined,
          workerModel: input.model,
          searchPlannerModel: input.model,
          searchPlannerOriginalRequest: userText,
          workerModelRules: workerModelRulesFromMetadata(input.metadata?.workerModelRules ?? session.init.metadata?.workerModelRules),
          turnContext: [prompt, currentAttachmentContext].filter(Boolean).join("\n\n"),
        }),
      });
      try {
        appendRuntimeTurnContextMetric({
          butlerData: this.butlerData,
          sessionId: input.handle.sessionId,
          model: input.model,
          totalPromptChars: prompt.length,
          promptContextChars: normalizedPrompt.promptContextChars,
          compactionContextChars: normalizedPrompt.compactionContextChars,
          feedbackBufferContextChars: normalizedPrompt.feedbackBufferContextChars,
          workingMemoryContextChars: normalizedPrompt.workingMemoryContextChars,
          recentConversationChars: normalizedPrompt.recentConversationChars,
          recallContextChars: normalizedPrompt.recallContextChars,
          inboundMessageChars: normalizedPrompt.inboundMessageChars,
        });
      } catch {
        // Context telemetry must never block user turns.
      }
      const runToolPrompt = async (
        promptText: string,
        maxToolRounds = DIRECT_TOOL_CHAIN_MAX_ROUNDS,
        phase = "tool_loop",
      ): Promise<string> => {
        throwIfRuntimeTurnAborted(input.signal);
        const grantedToolRounds = directToolRoundLimit(maxToolRounds);
        const usageAttribution: PromptUsageAttribution = {
          turnId,
          phase,
          budgetState: directTurnBudgetState(turnBudget),
          getBudgetState: () => directTurnBudgetState(turnBudget),
          beforeModelRequest: () => beforeDirectTurnModelRequest(turnBudget),
          afterModelResponseUsage: (usage) => addDirectTurnUsage({
            budget: turnBudget,
            promptTokens: usage.promptTokens,
            cachedTokens: usage.cachedTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          }),
          promptSections,
        };
        return await this.toolPromptRunner({
          prompt: promptText,
          model: input.model,
          instructions: appendButlerToolInstructions(session.init.systemPrompt),
          cacheScope: "session-turn",
          signal: input.signal,
          attachments,
          tools: BUTLER_TOOLS,
          maxToolRounds: grantedToolRounds,
          butlerData: this.butlerData,
          usageAttribution,
          executeTool: executor,
          finalTextFromToolResult: ({ name, output }) => {
            if (name === "write_planned_public_report") {
              return publicReportFromToolOutput(output);
            }
            if (plannedReview) {
              return plannedReviewTerminalToolText({
                name,
                output,
                language: this.messageLanguage,
              });
            }
            return null;
          },
          onAssistantTextBeforeTools: async ({ text, toolCalls }) => {
            throwIfRuntimeTurnAborted(input.signal);
            pendingPublicDecisions.push(...publicWorkDecisionsFromAssistantText({
              text,
              toolCalls,
              language: this.messageLanguage,
              existingDecisions: publicDecisionContext,
            }));
            await emitAssistantTextBeforeTools({
              turnInput: input,
              text,
              toolCalls,
              language: this.messageLanguage,
            });
          },
        });
      };
      const successfulToolAuditCount = () => audit.filter((entry) => entry.ok).length;
      const runGoalCompletionReviewGate = async (
        currentFinalText: string,
        reviewPromptText: string,
        maxToolRounds: number,
      ): Promise<string> => {
        let candidateFinalText = currentFinalText;
        let nextReviewPromptText = reviewPromptText;
        const maxContinuationAttempts = goalCompletionContinuationAttempts();
        for (let continuationAttempt = 0;; continuationAttempt += 1) {
          const successfulToolsBeforeReview = successfulToolAuditCount();
          const reviewText = await runToolPrompt(nextReviewPromptText, maxToolRounds, "goal_completion_review");
          const incompleteReason = completionReviewIncompleteReason(reviewText);
          const reviewAdvancedTheTurn = successfulToolAuditCount() > successfulToolsBeforeReview;
          if (!incompleteReason) return reviewAdvancedTheTurn ? reviewText : candidateFinalText;
          if (continuationAttempt >= maxContinuationAttempts) {
            throw goalCompletionIncompleteError(incompleteReason);
          }

          const successfulToolsBeforeContinuation = successfulToolAuditCount();
          const continuationText = await runToolPrompt(goalCompletionIncompleteContinuationPrompt({
            prompt,
            previousAnswer: reviewText,
            incompleteReason,
            audit,
            decisions: publicDecisionContext,
          }), 8, "goal_completion_continuation");
          const continuationAdvancedTheTurn =
            successfulToolAuditCount() > successfulToolsBeforeContinuation;
          const continuationIncompleteReason =
            completionReviewIncompleteReason(continuationText);
          if (continuationIncompleteReason && !continuationAdvancedTheTurn) {
            throw goalCompletionIncompleteError(continuationIncompleteReason);
          }
          candidateFinalText = continuationText;
          nextReviewPromptText = goalCompletionReviewPrompt({
            prompt,
            previousAnswer: candidateFinalText,
            audit,
            decisions: publicDecisionContext,
          });
        }
      };
      let text = "";
      if (useTools) {
        text = await runToolPrompt(prompt, DIRECT_TOOL_CHAIN_MAX_ROUNDS, "initial_tool_loop");
      } else {
        text = await this.promptRunner({
          prompt,
          model: input.model,
          instructions: session.init.systemPrompt,
          cacheScope: "session-turn",
          signal: input.signal,
          attachments,
          butlerData: this.butlerData,
          usageAttribution: {
            turnId,
            phase: "text_prompt",
            roundIndex: 0,
            budgetState: directTurnBudgetState(turnBudget),
            getBudgetState: () => directTurnBudgetState(turnBudget),
            beforeModelRequest: () => beforeDirectTurnModelRequest(turnBudget),
            afterModelResponseUsage: (usage) => addDirectTurnUsage({
              budget: turnBudget,
              promptTokens: usage.promptTokens,
              cachedTokens: usage.cachedTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
            }),
            promptSections,
          },
        });
      }
      throwIfRuntimeTurnAborted(input.signal);
      if (useTools) {
        const explicitTools = requiredExplicitToolNames(input.metadata, BUTLER_TOOLS.map((tool) => tool.name));
        for (let repairAttempt = 0; repairAttempt < 2; repairAttempt += 1) {
          const missingExplicitTools = explicitTools
            .filter((toolName) => !hasSuccessfulTool(audit, [toolName]));
          if (missingExplicitTools.length === 0) break;
          text = await runToolPrompt(explicitToolRequirementRepairPrompt({
            prompt,
            previousAnswer: text,
            missingTools: missingExplicitTools,
          }), Math.min(4, missingExplicitTools.length + 2), "explicit_tool_repair");
        }
      }
      const groundedText = useTools && shouldEnforceGrounding(input)
        ? enforceGroundedActionClaims({
            userText,
            responseText: text,
            audit,
            language: this.messageLanguage,
          })
        : text;
      let finalText = groundedText;
      if (
        useTools &&
        shouldEnforceGrounding(input) &&
        containsFinalPublicWorkDecisionLeak(finalText) &&
        !audit.some((entry) => entry.ok)
      ) {
        finalText = await runGoalCompletionReviewGate(finalText, goalCompletionReviewPrompt({
          prompt,
          previousAnswer: finalText,
          audit,
          decisions: publicDecisionContext,
        }), 4);
      }
      if (
        useTools &&
        shouldEnforceGrounding(input) &&
        shouldRunGoalCompletionReview(input.metadata, session.init.role) &&
        !hasGoalCompletionReviewSkipTool(audit) &&
        audit.some((entry) => entry.ok)
      ) {
        const successfulToolNamesForReview = audit
          .filter((entry) => entry.ok)
          .map((entry) => entry.name);
        const preReviewObligationIncompleteReason = completionObligationIncompleteReason({
          audit,
          decisions: publicDecisionContext,
        });
        const preReviewNeedsContractRepair =
          containsFinalPublicWorkDecisionLeak(finalText) ||
          containsFinalToolImplementationLeak(finalText, successfulToolNamesForReview);
        const shouldRunModelCompletionReview =
          !hasVerifiedEvidenceReceipt(audit) ||
          hasPendingReadRequirement(audit) ||
          Boolean(preReviewObligationIncompleteReason) ||
          preReviewNeedsContractRepair;
        if (shouldRunModelCompletionReview) {
          finalText = await runGoalCompletionReviewGate(finalText, goalCompletionReviewPrompt({
            prompt,
            previousAnswer: finalText,
            audit,
            decisions: publicDecisionContext,
          }), 4);
        }
        const obligationIncompleteReason = completionObligationIncompleteReason({
          audit,
          decisions: publicDecisionContext,
        });
        if (obligationIncompleteReason) {
          finalText = await runGoalCompletionReviewGate(finalText, goalCompletionReviewPrompt({
            prompt,
            previousAnswer: [
              `INCOMPLETE: ${obligationIncompleteReason}`,
              "",
              "Previous draft:",
              finalText,
            ].join("\n"),
            audit,
            decisions: publicDecisionContext,
          }), 4);
          const secondObligationIncompleteReason = completionObligationIncompleteReason({
            audit,
            decisions: publicDecisionContext,
          });
          if (secondObligationIncompleteReason) {
            throw goalCompletionIncompleteError(
              secondObligationIncompleteReason ?? obligationIncompleteReason,
            );
          }
        }
      }
      if (useTools) {
        const maxDirectWorkContinuations = directWorkContinuationAttempts();
        for (let repairAttempt = 0; repairAttempt < maxDirectWorkContinuations; repairAttempt += 1) {
          const blocker = finalDeliveryBlockerForOpenDirectWork({
            butlerData: this.butlerData,
            sessionId: input.handle.sessionId,
          });
          if (!blocker) break;
          const successfulToolsBeforeContinuation = successfulToolAuditCount();
          finalText = await runToolPrompt(openDirectWorkContinuationPrompt({
            objective: userText,
            audit,
            blocker,
          }), 8, "direct_work_continuation");
          if (successfulToolAuditCount() <= successfulToolsBeforeContinuation) break;
        }
        const remainingBlocker = finalDeliveryBlockerForOpenDirectWork({
          butlerData: this.butlerData,
          sessionId: input.handle.sessionId,
        });
        if (remainingBlocker) {
          throw goalCompletionIncompleteError(
            `active direct work stream is not deliverable: ${remainingBlocker.title}`,
          );
        }
      }
      const successfulToolNames = audit
        .filter((entry) => entry.ok)
        .map((entry) => entry.name);
      const finalNeedsContractRepair = containsFinalPublicWorkDecisionLeak(finalText) ||
        containsFinalToolImplementationLeak(finalText, successfulToolNames);
      if (useTools && finalNeedsContractRepair) {
        const repairedFinalText = await runToolPrompt(finalResultContractRepairPrompt({
          prompt,
          previousAnswer: finalText,
          audit,
          decisions: publicDecisionContext,
        }), 1, "final_contract_repair");
        const repairedStillLeaks = containsFinalPublicWorkDecisionLeak(repairedFinalText) ||
          containsFinalToolImplementationLeak(repairedFinalText, successfulToolNames);
        const strippedFinalText = repairedStillLeaks
          ? stripToolImplementationLeakLines(stripLeadingPublicWorkDecisionBlock(repairedFinalText), successfulToolNames)
          : "";
        finalText = repairedStillLeaks
          ? strippedFinalText || finalContractFallbackText(this.messageLanguage)
          : repairedFinalText;
        recordOperationalMetric({
          category: "runtime",
          name: "final_result_contract_guard",
          status: "ok",
          dimensions: {
            role: session.init.role,
            runtime: this.id,
            model: input.model,
            detail: repairedStillLeaks ? "fallback" : "repair",
          },
        }, { butlerData: this.butlerData });
      }
      await emitTurnEventBestEffort(input, {
        kind: "guard.started",
        payload: {
          guard: "public_output",
        },
      });
      const intentGuardDecision = useTools && shouldEnforceGrounding(input)
        ? applyRuntimeIntentGuardsWithDecision({
            userText,
            responseText: finalText,
            audit,
            language: this.messageLanguage,
          })
        : { text: finalText, guard: "none" as const };
      const intentCheckedText = intentGuardDecision.text;
      if (intentGuardDecision.guard !== "none") {
        recordIntentGuardMetric({
          butlerData: this.butlerData,
          role: session.init.role,
          runtime: this.id,
          model: input.model,
          guard: intentGuardDecision.guard,
          detail: intentGuardDecision.detail ?? "none",
        });
      }
      const citedText = useTools
        ? applyWebSearchCitationGuard({
            text: intentCheckedText,
            audit,
          })
        : intentCheckedText;
      const decisionCheckedText = citedText;
      await emitTurnEventBestEffort(input, {
        kind: "guard.completed",
        payload: {
          guard: "public_output",
          status: "approved",
        },
      });
      if (useTools) {
        completeRuntimeSemanticWorkStreamBestEffort({
          butlerData: this.butlerData,
          sessionId: input.handle.sessionId,
          projectId: typeof session.init.metadata?.projectId === "string" ? session.init.metadata.projectId : undefined,
          tracker: semanticProgressSafetyNet,
          language: this.messageLanguage,
        });
        completeReportingWorkStreamBestEffort({
          butlerData: this.butlerData,
          sessionId: input.handle.sessionId,
        });
      }
      await emitTurnEventBestEffort(input, {
        kind: "message.final.started",
        payload: {
          safeLabel: "Preparing final answer",
        },
      });
      await emitTurnEventBestEffort(input, {
        kind: "message.final.completed",
        payload: {
          safeLabel: "Final answer ready",
          textChars: decisionCheckedText.length,
        },
      });
      await emitTurnEventBestEffort(input, {
        kind: "turn.completed",
        payload: {
          safeLabel: "Completed",
        },
      });

      recordOperationalMetric({
        category: "runtime",
        name: "turn",
        status: "ok",
        durationMs: Date.now() - startedAt,
        dimensions: {
          role: session.init.role,
          runtime: this.id,
          model: input.model,
          useTools,
          toolCalls: audit.length,
          publicDecisions: publicDecisionContext.length,
          publicDecisionAssistantAuthored: publicDecisionContext
            .filter((decision) => decision.source === "assistant-authored").length,
          publicDecisionRuntimeDerived: publicDecisionContext
            .filter((decision) => decision.source === "runtime-derived").length,
          recallContextChars: normalizedPrompt.recallContextChars,
          compactionContextChars: normalizedPrompt.compactionContextChars,
          workingMemoryContextChars: normalizedPrompt.workingMemoryContextChars,
          promptChars: prompt.length,
        },
      }, { butlerData: this.butlerData });

      return {
        text: decisionCheckedText,
        runtimeSessionRef: input.handle.runtimeSessionRef,
        artifacts: runtimeArtifactsFromAudit({
          audit,
          butlerData: this.butlerData,
          workspacePath: session.init.workspacePath,
        }),
      };
    } catch (error) {
      if (useTools && !input.signal?.aborted) {
        markActiveWorkStreamRecoverableBestEffort({
          butlerData: this.butlerData,
          sessionId: input.handle.sessionId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      await emitTurnEventBestEffort(input, {
        kind: input.signal?.aborted ? "turn.cancelled" : "turn.failed",
        payload: {
          safeLabel: input.signal?.aborted ? "Cancelled" : "Failed",
        },
      });
      recordOperationalMetric({
        category: "runtime",
        name: "turn",
        status: "error",
        durationMs: Date.now() - startedAt,
        dimensions: {
          role: session.init.role,
          runtime: this.id,
          model: input.model,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
      }, { butlerData: this.butlerData });
      throw error;
    }
  }

  async closeSession(handle: RuntimeSessionHandle): Promise<void> {
    this.sessions.delete(handle.sessionId);
  }
}

function createAuditedButlerToolExecutor(input: {
  sessionId: string;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
  pendingPublicDecisions: PublicWorkDecision[];
  turnInput: RuntimeTurnInput;
  butlerData: string;
  messageLanguage: RuntimeMessageLanguage;
  plannedReview: PlannedReviewTurnContext | null;
  semanticProgressSafetyNet: RuntimeSemanticProgressSafetyNet;
  executor: FunctionToolPromptOptions["executeTool"];
}): FunctionToolPromptOptions["executeTool"] {
  let semanticProgressEstablished = false;
  let currentSemanticWorkBlock: { id: string; label: string } | null = null;
  const projectLedgerFreshnessCache = new Map<string, unknown>();
  const projectLedgerFreshnessCacheKey = (call: {
    name: string;
    args: Record<string, unknown>;
  }): string | null => {
    if (call.name === "inspect_project_status") {
      return `inspect_project_status:${stableJsonForCache({
        project_path: typeof call.args.project_path === "string" ? call.args.project_path.trim() : "",
      })}`;
    }
    if (call.name === "query_project_work") {
      return `query_project_work:${stableJsonForCache({
        project_path: typeof call.args.project_path === "string" ? call.args.project_path.trim() : "",
        kind: typeof call.args.kind === "string" ? call.args.kind.trim() : "",
      })}`;
    }
    return null;
  };
  const invalidateProjectLedgerFreshnessAfterTool = (call: {
    name: string;
    args: Record<string, unknown>;
  }): void => {
    if (call.name === "run_command") {
      projectLedgerFreshnessCache.clear();
      return;
    }
    if (call.name === "complete_project_work") {
      projectLedgerFreshnessCache.clear();
      return;
    }
    if (call.name === "render_project_dashboard" && call.args.write === true) {
      projectLedgerFreshnessCache.clear();
    }
  };
  const executeWithTurnFreshnessCache = async (
    call: Parameters<FunctionToolPromptOptions["executeTool"]>[0],
  ): Promise<unknown> => {
    const cacheKey = projectLedgerFreshnessCacheKey(call);
    if (cacheKey && projectLedgerFreshnessCache.has(cacheKey)) {
      return projectLedgerFreshnessCache.get(cacheKey);
    }
    const result = await input.executor(call);
    if (cacheKey) {
      projectLedgerFreshnessCache.set(cacheKey, result);
    } else {
      invalidateProjectLedgerFreshnessAfterTool(call);
    }
    return result;
  };
  const repeatedToolFamilyCounts = new Map<string, number>();
  const runInternalProgressTool = async (
    call: Parameters<FunctionToolPromptOptions["executeTool"]>[0],
    source: "model" | "runtime",
  ) => {
    throwIfRuntimeTurnAborted(input.turnInput.signal);
    const startedAt = Date.now();
    const cleanArgs = { ...call.args };
    discardPendingPublicDecisionForTool(input.pendingPublicDecisions, call.name);
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: input.sessionId,
      kind: "tool_call",
      payload: {
        name: call.name,
        arguments: cleanArgs,
      },
      metadata: {
        source: source === "runtime"
          ? "runtime/native-tool-loop.ts#semantic-progress-safety-net"
          : "runtime/native-tool-loop.ts",
      },
    }));
    try {
      const result = await input.executor(call);
      throwIfRuntimeTurnAborted(input.turnInput.signal);
      recordOperationalMetric({
        category: "tool",
        name: call.name,
        status: "ok",
        durationMs: Date.now() - startedAt,
        dimensions: {
          sessionRole: input.turnInput.handle.role,
          toolName: call.name,
        },
      }, { butlerData: input.butlerData });
      input.audit.push({
        name: call.name,
        args: cleanArgs,
        ok: true,
        result,
        satisfiedCompletionObligations: satisfiedCompletionObligationsForToolResult(call.name, result),
        evidenceReceipts: evidenceReceiptsFromResult(result),
      });
      if (call.name === "update_todo_list") {
        semanticProgressEstablished = true;
        currentSemanticWorkBlock = activeTodoWorkBlockFromArgs(cleanArgs);
        input.semanticProgressSafetyNet.source = source;
        input.semanticProgressSafetyNet.listId =
          typeof cleanArgs.list_id === "string" && cleanArgs.list_id.trim()
            ? cleanArgs.list_id.trim()
            : "main";
        input.semanticProgressSafetyNet.title =
          typeof cleanArgs.title === "string" && cleanArgs.title.trim()
            ? cleanArgs.title.trim()
            : input.semanticProgressSafetyNet.title;
        await emitTodoProgressBestEffort({
          turnInput: input.turnInput,
          args: cleanArgs,
        });
      }
      appendTranscriptEvent(createTranscriptEvent({
        sessionId: input.sessionId,
        kind: "tool_result",
        payload: {
          name: call.name,
          ok: true,
          result,
        },
        metadata: {
          source: source === "runtime"
            ? "runtime/native-tool-loop.ts#semantic-progress-safety-net"
            : "runtime/native-tool-loop.ts",
        },
      }));
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordOperationalMetric({
        category: "tool",
        name: call.name,
        status: "error",
        durationMs: Date.now() - startedAt,
        dimensions: {
          sessionRole: input.turnInput.handle.role,
          toolName: call.name,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
      }, { butlerData: input.butlerData });
      input.audit.push({
        name: call.name,
        args: cleanArgs,
        ok: false,
        error: message,
      });
      appendTranscriptEvent(createTranscriptEvent({
        sessionId: input.sessionId,
        kind: "tool_result",
        payload: {
          name: call.name,
          ok: false,
          error: message,
        },
        metadata: {
          source: source === "runtime"
            ? "runtime/native-tool-loop.ts#semantic-progress-safety-net"
            : "runtime/native-tool-loop.ts",
        },
      }));
      if (
        input.turnInput.signal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw error;
      }
      return {
        ok: false,
        error: message,
      };
    }
  };
  const runRuntimeSemanticProgressUpdate = async (inputUpdate: {
    decision: PublicWorkDecision;
    progress: ToolProgressSummary;
    state: "execution" | "review";
  }) => {
    const title = sanitizePublicText(
      inputUpdate.decision.summary,
      input.messageLanguage === "ko" ? "진행 중인 작업" : "Current work",
    ).slice(0, 120) || (input.messageLanguage === "ko" ? "진행 중인 작업" : "Current work");
    const executionLabel = sanitizePublicText(
      inputUpdate.progress.workBlockLabel ||
        inputUpdate.progress.safeLabel ||
        inputUpdate.decision.summary,
      title,
    ).slice(0, 180) || title;
    input.semanticProgressSafetyNet.title = title;
    input.semanticProgressSafetyNet.lastExecutionLabel = executionLabel;
    const args = {
      list_id: input.semanticProgressSafetyNet.listId,
      title,
      todos: runtimeSemanticTodoItems({
        language: input.messageLanguage,
        executionLabel,
        state: inputUpdate.state,
      }),
    };
    await runInternalProgressTool({
      name: "update_todo_list",
      args,
      rawArguments: JSON.stringify(args),
    }, "runtime");
  };
  return async (call) => {
    throwIfRuntimeTurnAborted(input.turnInput.signal);
    const startedAt = Date.now();
    const cleanArgs = { ...call.args };
    const inboundEnvelope = "eventId" in input.turnInput.input ? input.turnInput.input : null;
    if (isInternalProgressTool(call.name)) {
      return await runInternalProgressTool(call, "model");
    }
    if (input.plannedReview) {
      const reviewTaskId = input.plannedReview.taskId;
      if (PLANNED_REVIEW_SCOPED_TOOLS.has(call.name)) {
        if (typeof cleanArgs.task_id !== "string" || !cleanArgs.task_id.trim()) {
          cleanArgs.task_id = reviewTaskId;
        }
        if (input.plannedReview.attempt && typeof cleanArgs.attempt !== "number") {
          cleanArgs.attempt = input.plannedReview.attempt;
        }
        if (
          input.plannedReview.workerTaskId &&
          (typeof cleanArgs.worker_task_id !== "string" || !cleanArgs.worker_task_id.trim())
        ) {
          cleanArgs.worker_task_id = input.plannedReview.workerTaskId;
        }
        if (
          input.plannedReview.reviewEventId &&
          (typeof cleanArgs.review_event_id !== "string" || !cleanArgs.review_event_id.trim())
        ) {
          cleanArgs.review_event_id = input.plannedReview.reviewEventId;
        }
      }
      const requestedTaskId = typeof cleanArgs.task_id === "string" ? cleanArgs.task_id.trim() : "";
      const blocksSiblingStart = PLANNED_REVIEW_FORBIDDEN_START_TOOLS.has(call.name);
      const targetsDifferentPlannedTask =
        PLANNED_REVIEW_SCOPED_TOOLS.has(call.name) &&
        Boolean(requestedTaskId) &&
        requestedTaskId !== reviewTaskId;
      if (blocksSiblingStart || targetsDifferentPlannedTask) {
        const error = blocksSiblingStart
          ? `planned-review turns cannot start sibling work with ${call.name}; use review_planned_task, repair_planned_task, request_principal_decision, or write_planned_public_report for ${reviewTaskId}`
          : `planned-review turn for ${reviewTaskId} cannot operate on ${requestedTaskId}`;
        input.audit.push({
          name: call.name,
          args: cleanArgs,
          ok: false,
          error,
        });
        appendTranscriptEvent(createTranscriptEvent({
          sessionId: input.sessionId,
          kind: "tool_result",
          payload: {
            name: call.name,
            ok: false,
            error,
            planned_review_task_id: reviewTaskId,
          },
          metadata: {
            source: "runtime/native-tool-loop.ts#planned-review-policy",
          },
        }));
        return {
          ok: false,
          error,
          planned_review_task_id: reviewTaskId,
          blocked_tool: call.name,
          allowed_next_tools: [
            "review_planned_task",
            "repair_planned_task",
            "request_principal_decision",
            "write_planned_public_report",
          ],
        };
      }
    }
    const repeatFamily = repeatedToolFamilyKey(call.name, cleanArgs);
    if (repeatFamily) {
      const count = (repeatedToolFamilyCounts.get(repeatFamily) ?? 0) + 1;
      repeatedToolFamilyCounts.set(repeatFamily, count);
      if (count > REPEATED_TOOL_FAMILY_LIMIT) {
        const result = repeatedToolFamilyPolicyResult({
          family: repeatFamily,
          count,
          limit: REPEATED_TOOL_FAMILY_LIMIT,
        });
        appendTranscriptEvent(createTranscriptEvent({
          sessionId: input.sessionId,
          kind: "tool_call",
          payload: {
            name: call.name,
            arguments: cleanArgs,
          },
          metadata: {
            source: "runtime/native-tool-loop.ts#repeated-tool-family-guard",
            repeat_family: repeatFamily,
          },
        }));
        appendTranscriptEvent(createTranscriptEvent({
          sessionId: input.sessionId,
          kind: "tool_result",
          payload: {
            name: call.name,
            ok: false,
            result,
          },
          metadata: {
            source: "runtime/native-tool-loop.ts#repeated-tool-family-guard",
            repeat_family: repeatFamily,
          },
        }));
        recordOperationalMetric({
          category: "runtime",
          name: "repeated_tool_family_guard",
          status: "ok",
          durationMs: Date.now() - startedAt,
          dimensions: {
            sessionRole: input.turnInput.handle.role,
            toolName: call.name,
            repeatFamily,
            repeatCount: String(count),
          },
        }, { butlerData: input.butlerData });
        input.audit.push({
          name: call.name,
          args: cleanArgs,
          ok: false,
          error: String(result.message),
        });
        return result;
      }
    }
    const isWorkerStartTool = WORKER_ORCHESTRATION_START_TOOL_SET.has(call.name);
    const effectiveCall = { ...call, args: cleanArgs };
    const taskSummary = typeof cleanArgs.task === "string" && cleanArgs.task.trim()
      ? cleanArgs.task.trim()
      : call.name === "resume_worker"
        ? "Continue the most recent recoverable background task."
        : "";
    const progress = summarizeToolProgress(call.name, cleanArgs, input.messageLanguage);
    const toolCallId = `tool-${randomUUID().slice(0, 8)}`;
    const decision = takePublicWorkDecisionForTool({
      pending: input.pendingPublicDecisions,
      toolName: call.name,
      progress,
      language: input.messageLanguage,
      previousDecisions: input.publicDecisionContext,
    });
    if (
      input.semanticProgressSafetyNet.source === "runtime" &&
      !isWorkerStartTool
    ) {
      await runRuntimeSemanticProgressUpdate({
        decision,
        progress,
        state: "execution",
      });
    } else if (
      !semanticProgressEstablished &&
      shouldSynthesizeRuntimeSemanticProgress({
        callName: call.name,
        args: cleanArgs,
      })
    ) {
      await runRuntimeSemanticProgressUpdate({
        decision,
        progress,
        state: "execution",
      });
    }
    const semanticWorkBlock = semanticProgressEstablished ? currentSemanticWorkBlock : null;
    const usesSemanticWorkBlock = Boolean(semanticWorkBlock);
    const workBlockId = semanticWorkBlock?.id ?? `work-${toolCallId}`;
    decision.workBlockId = workBlockId;
    decision.toolName = call.name;
    const workBlockLabel = semanticWorkBlock?.label ?? decision.summary;
    input.publicDecisionContext.push(decision);
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: input.sessionId,
      kind: "system",
      payload: {
        category: "public_work_decision",
        decision: publicWorkDecisionPayload(decision),
      },
      metadata: {
        source: "runtime/native-tool-loop.ts",
      },
    }));
    if (!semanticProgressEstablished && !isWorkerStartTool) {
      await emitDecisionProgressBestEffort({
        turnInput: input.turnInput,
        decision,
        state: "running",
      });
    }
    await emitTurnEventBestEffort(input.turnInput, {
      kind: "work.block.started",
      payload: {
        workBlockId,
        label: workBlockLabel,
        activityKind: progress.kind,
        ...publicWorkDecisionPayload(decision),
      },
    });
    await emitTurnEventBestEffort(input.turnInput, {
      kind: "tool.started",
      payload: {
        toolCallId,
        workBlockId,
        workBlockLabel,
        activityKind: progress.kind,
        toolName: progress.toolName,
        inputLabel: progress.inputLabel,
        safeLabel: progress.safeLabel,
        ...publicWorkDecisionPayload(decision),
        detailRows: progress.detailRows,
      },
    });
    if (inboundEnvelope && input.turnInput.emitIntermediateDelivery) {
      await emitIntermediateBestEffort(
        input.turnInput,
        buildIntermediateAction({
          envelope: inboundEnvelope,
          suffix: `${call.name}-${randomUUID().slice(0, 8)}-progress`,
          text: "",
          metadata: {
            kind: "tool_progress",
            activityKind: progress.kind,
            toolCallId,
            toolName: progress.toolName,
            safeLabel: progress.safeLabel,
            inputLabel: progress.inputLabel,
            workBlockId,
            workBlockLabel,
            ...publicWorkDecisionPayload(decision),
            detailRows: progress.detailRows,
          },
        }),
        {
          source: "runtime/native-tool-loop.ts#tool-progress",
          kind: "tool_progress",
          tool: call.name,
        },
      );
    }
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: input.sessionId,
      kind: "tool_call",
      payload: {
        name: call.name,
        arguments: cleanArgs,
      },
      metadata: {
        source: "runtime/native-tool-loop.ts",
      },
    }));
    try {
      throwIfRuntimeTurnAborted(input.turnInput.signal);
      const result = await executeWithTurnFreshnessCache(effectiveCall);
      throwIfRuntimeTurnAborted(input.turnInput.signal);
      if (isStateMutatingToolCall(call.name, cleanArgs)) {
        repeatedToolFamilyCounts.clear();
      }
      recordOperationalMetric({
        category: "tool",
        name: call.name,
        status: "ok",
        durationMs: Date.now() - startedAt,
        dimensions: {
          sessionRole: input.turnInput.handle.role,
          toolName: call.name,
        },
      }, { butlerData: input.butlerData });
      if (isWorkerStartTool) {
        const taskId = taskIdFromToolResult(result);
        const project = typeof cleanArgs.project_path === "string" ? cleanArgs.project_path.trim() : null;
        if (taskId && taskSummary) {
          new TaskStore(input.butlerData).writeOrigin(taskId, buildTaskOriginContext({
            sessionId: input.sessionId,
            taskSummary,
            project,
            inbound: inboundEnvelope,
          }));
        }
      }
      input.audit.push({
        name: call.name,
        args: cleanArgs,
        ok: true,
        result,
        publicDecision: decision,
        satisfiedCompletionObligations: satisfiedCompletionObligationsForToolResult(call.name, result),
        evidenceReceipts: evidenceReceiptsFromResult(result),
      });
      const completedProgress = completedToolProgressSummary(progress, result);
      await emitTurnEventBestEffort(input.turnInput, {
        kind: "tool.completed",
        payload: {
          toolCallId,
          workBlockId,
          workBlockLabel,
          activityKind: completedProgress.kind,
          toolName: completedProgress.toolName,
          inputLabel: completedProgress.inputLabel,
          safeLabel: completedProgress.safeLabel,
          ...publicWorkDecisionPayload(decision),
          detailRows: completedProgress.detailRows,
          durationMs: Date.now() - startedAt,
        },
      });
      if (
        inboundEnvelope &&
        input.turnInput.emitIntermediateDelivery &&
        completedProgress !== progress
      ) {
        await emitIntermediateBestEffort(
          input.turnInput,
          buildIntermediateAction({
            envelope: inboundEnvelope,
            suffix: `${call.name}-${randomUUID().slice(0, 8)}-completed-progress`,
            text: "",
            metadata: {
              kind: "tool_progress",
              activityKind: completedProgress.kind,
              toolCallId,
              toolName: completedProgress.toolName,
              safeLabel: completedProgress.safeLabel,
              inputLabel: completedProgress.inputLabel,
              workBlockId,
              workBlockLabel,
              ...publicWorkDecisionPayload(decision),
              detailRows: completedProgress.detailRows,
              state: "delivered",
            },
          }),
          {
            source: "runtime/native-tool-loop.ts#tool-progress",
            kind: "tool_progress",
            tool: call.name,
          },
        );
      }
      if (input.semanticProgressSafetyNet.source === "runtime" && !isWorkerStartTool) {
        await runRuntimeSemanticProgressUpdate({
          decision,
          progress: completedProgress,
          state: "review",
        });
      }
      if (!semanticProgressEstablished && !isWorkerStartTool) {
        await emitDecisionProgressBestEffort({
          turnInput: input.turnInput,
          decision,
          state: "delivered",
        });
      }
      if (!usesSemanticWorkBlock) {
        await emitTurnEventBestEffort(input.turnInput, {
          kind: "work.block.completed",
          payload: {
            workBlockId,
            label: workBlockLabel,
            status: "completed",
            ...publicWorkDecisionPayload(decision),
            durationMs: Date.now() - startedAt,
          },
        });
      }
      const modelVisibleResult = annotateToolResultWithDecisionContext({
        result,
        decision,
        decisions: input.publicDecisionContext,
      });
      appendTranscriptEvent(createTranscriptEvent({
        sessionId: input.sessionId,
        kind: "tool_result",
        payload: {
          name: call.name,
          ok: true,
          result,
          publicDecision: publicWorkDecisionPayload(decision),
        },
        metadata: {
          source: "runtime/native-tool-loop.ts",
        },
      }));
      return modelVisibleResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      invalidateProjectLedgerFreshnessAfterTool(effectiveCall);
      recordOperationalMetric({
        category: "tool",
        name: call.name,
        status: "error",
        durationMs: Date.now() - startedAt,
        dimensions: {
          sessionRole: input.turnInput.handle.role,
          toolName: call.name,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
      }, { butlerData: input.butlerData });
      input.audit.push({
        name: call.name,
        args: cleanArgs,
        ok: false,
        error: message,
        publicDecision: decision,
      });
      await emitTurnEventBestEffort(input.turnInput, {
        kind: "tool.failed",
        payload: {
          toolCallId,
          workBlockId,
          workBlockLabel,
          activityKind: progress.kind,
          toolName: progress.toolName,
          inputLabel: progress.inputLabel,
          safeLabel: progress.safeLabel,
          ...publicWorkDecisionPayload(decision),
          durationMs: Date.now() - startedAt,
        },
      });
      if (!semanticProgressEstablished && !isWorkerStartTool) {
        await emitDecisionProgressBestEffort({
          turnInput: input.turnInput,
          decision,
          state: "failed",
        });
      }
      if (!usesSemanticWorkBlock) {
        await emitTurnEventBestEffort(input.turnInput, {
          kind: "work.block.completed",
          payload: {
            workBlockId,
            label: workBlockLabel,
            status: "failed",
            ...publicWorkDecisionPayload(decision),
            durationMs: Date.now() - startedAt,
          },
        });
      }
      appendTranscriptEvent(createTranscriptEvent({
        sessionId: input.sessionId,
        kind: "tool_result",
        payload: {
          name: call.name,
          ok: false,
          error: message,
          publicDecision: publicWorkDecisionPayload(decision),
        },
        metadata: {
          source: "runtime/native-tool-loop.ts",
        },
      }));
      if (
        input.turnInput.signal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw error;
      }
      return annotateToolResultWithDecisionContext({
        result: {
          ok: false,
          error: message,
        },
        decision,
        decisions: input.publicDecisionContext,
      });
    }
  };
}

function appendButlerToolInstructions(systemPrompt?: string): string {
  const toolContract = [
    "## Butler Turn Cognition Cycle",
    "- Every Butler or Steward turn follows this internal work discipline: `구상`, `계획`, `실행`, `검토`, `취합 및 정리`, `보고`. This strengthens work quality but must not expose chain-of-thought, raw prompt text, private memory text, or tool payloads.",
    "- In `구상`, identify the user's intent, what extra context is needed, Butler's role in this message, and the expected final deliverable. Use recent conversation, working memory, feedback, bounded `read_conversation_context`, associative `recall_memory`, or exact `query_memory` only when the current prompt context is not enough.",
    "- In `계획`, choose the work path: direct answer for simple few-second no-tool requests, visible direct toolchain for bounded same-turn work, planned dispatch for reviewed durable work, or `create_work_orchestration` when multiple role-aware streams are needed. For non-trivial work, create structured phase/step progress before visible action tools.",
    "- In `실행`, carry out the selected direct tools or worker/orchestration streams and keep public work decisions tied to the immediate tool action.",
    "- In `검토`, compare observed evidence, public work decisions, completion obligations, worker criteria, and requested deliverables against the original goal. Continue execution or report explicit incomplete/failure when evidence is missing.",
    "- In `취합 및 정리`, synthesize the reviewed evidence into a concise outcome draft and internally check whether the result is sufficient; keep any self-evaluation raw-text-free.",
    "- In `보고`, produce the final persona-aligned answer only after review. Do not dump the cycle checklist, public decision fields, raw tool logs, or hidden reasoning in the final answer.",
    "## Persona Continuity",
    "- The Active Persona and any current-turn Active Persona Reminder are binding for every user-facing final answer, public work decision, and visible status text.",
    "- Use the configured Assistant Response Language from the Turn Environment for every user-facing final answer, public work decision, and visible status text.",
    "- Preserve the persona's tone and signature speech patterns in every situation; if the persona text is written in another language, translate or adapt that voice into the configured response language.",
    "- Do not let native tool, review, or report formatting instructions erase the persona.",
    "## Default Response Shape",
    "- Keep default answers compact and outcome-first. For ordinary questions, prefer one to three short paragraphs or a short flat list.",
    "- Do not expand the internal BTCC cycle, routing policy, validation gates, or tool mechanics unless the user asks for those details.",
    "- Longer reports are appropriate only when the requested deliverable needs evidence, comparison, sources, or implementation closeout.",
    "- End with the next concrete state or outcome, not a generic offer.",
    "## Native Butler Tools",
    "- When a user request depends on current, external, public, or user-environment state, choose and call the appropriate tool from the current tool catalog before answering. Do not ask the user to name the tool.",
    "- You can call `web_search` for current public information or external sources. When search materially informs the answer, include a concise Sources section with markdown links returned by the tool.",
    "- Use the fewest web searches needed. For simple factual lookup questions, one to three searches are normally enough; once useful evidence is available, stop searching and answer.",
    "- For broad or multi-domain search requests, make one initial `web_search` call with a request-level query before manually splitting into many searches; `web_search` may internally plan source-aware queries and return a search plan.",
    "- Domain-specific tool preferences belong in structured capability, know-how, feedback, or tool contract records, not in this generic instruction block. When such guidance is attached to the turn, inspect it as evidence and choose the tool path yourself.",
    "- When the user explicitly gives source-quality or preference feedback, use the available feedback or memory tools that match the active capability schema before answering so the correction can affect future routing.",
    "- Do not declare failure from a single weak or inconclusive search while search/read capabilities remain available. Broaden the query, try a more authoritative source path, or read a candidate before returning an incomplete outcome.",
    "- If the requested claim depends on volatile current state, call an evidence-gathering tool before making a confident recommendation or comparison. Never answer volatile current-state questions from model priors alone.",
    "- You can call `web_read` on a public URL returned by search when the answer depends on page-body evidence, exact quotes, article details, or current news synthesis. Prefer bounded evidence over search snippets for these claims.",
    "- You can call `run_command` to run a single non-interactive bash command in the active Butler or Steward session workspace for local inspection, data transformation, file creation, or verification. The command is part of the visible work chain, not a background worker.",
    "- Prefer small, targeted `run_command` calls whose stdout/stderr can drive the next step. If output is compacted into a tool-output artifact, call `read_tool_output_artifact` for a focused slice instead of rerunning noisy commands.",
    "- Use `recall_memory` for associative memory anchors and `query_memory` for exact memory/history dates, counts, first/last, earliest/latest, speaker, or text-filtered transcript evidence. Do not use `run_command` to scan Butler transcript files for memory chronology while `query_memory` can satisfy the same exact lookup.",
    "- When calling `recall_memory` for non-trivial prior-memory questions, include `strategies` and `evidence_required` that match the evidence you need. This is the model-visible retrieval plan: vector, lexical, graph, explicit, recent-context, and task-state evidence must be requested explicitly instead of relying on a fixed fallback ranking score. If you omit the recall policy, Butler may run a bounded retrieval planner before executing recall.",
    "- For loosely referenced prior-conversation memory questions, decide whether associative recall is needed before exact transcript lookup. Use the current user wording as the recall cue when recall is useful.",
    "- For local config, manifest, script, log, or code searches based on user wording, prefer structured extraction or case-insensitive search. Do not conclude that something is absent from a single exact case-sensitive text match, especially when the user supplied a human-facing name that may differ from file casing or key casing.",
    "- Keep `run_command.command` JSON-safe for tool-calling models: use one-line commands where practical, avoid literal newlines inside the command string, escape quotes carefully, and split long scripts into multiple short commands instead of one fragile multiline heredoc.",
    "- When the user asks for a chart, generated file, saved report, or executable-code outcome, create or verify the result with an execution-capable tool when one is available. Return copy-paste code only when the user explicitly asks for code only.",
    "- Do not claim that a chat, text-only response, or UI environment prevents creating or providing files, images, charts, saved reports, or executable outputs while an artifact-capable native tool can still advance the outcome.",
    "- For bounded interactive requests that ask for a same-turn report, public evidence, CSV, chart, local file, saved output, or verification step, prefer visible turn-local tools such as `web_search`, `web_read`, `transform_public_data_table`, and `run_command`. Keep working in the current turn until the final answer is ready.",
    "- If the user supplies an output path or asks you to create and check files, use `run_command` or another artifact-capable tool to create the files and verify they exist before the final answer. Do not replace this with a background worker heartbeat unless the user explicitly asks for asynchronous work.",
    "- For non-trivial multi-step work, make the first tool call `update_todo_list` with three to six semantic goal steps before visible external/action tools such as search, read, or command execution. Set each todo item's `phase` to one of `conception`, `planning`, `execution`, `review`, `consolidation`, or `reporting`; keep exactly one item `in_progress` and update the list as stages complete.",
    "- Treat a direct turn as non-trivial when the user asks for two or more independent checks, combines local inspection with a final synthesis/report, explicitly asks you to plan/execute/review the work, or needs command/source evidence before the answer. In those cases, start with `update_todo_list` even if the work can finish in the same turn.",
    "- Repository or project verification that combines state inspection with config/script inspection is non-trivial. For example, checking the current branch plus package scripts must start with `update_todo_list` before `run_command`, then update the todo list after reviewing the command output.",
    "- Each non-trivial `update_todo_list` creates or advances a Butler-owned durable WorkStream for the active session/project. Project sessions and future super sessions are both user-facing Butler sessions; Steward remains an internal project/workstream custodian role.",
    "- Use `list_work_streams` when context switching across concurrent issues, and `update_work_stream_state` when a stream needs to pause, wait for the user, recover, or explicitly move through review/consolidation/reporting. Do not route user-facing project chat directly to Steward.",
    "- When `run_command` creates or verifies durable files, include `output_paths` with the relative files the command should produce or check so Butler can return structured artifact evidence.",
    "- Tool definitions describe available capabilities. Choose tools from the current objective, observed evidence, and schema fit; do not rely on request-word shortcuts or hardcoded workflow shortcuts.",
    "- Treat discovery/search outputs as candidates. When the task requires verification, source-backed claims, or a durable artifact grounded in external evidence, use an available read, inspect, or query capability on at least one candidate before treating the evidence as verified.",
    "- Do not build an evidence-backed report, table, artifact, recommendation, or current-state claim from search snippets alone when a public candidate can be read or inspected. Read or inspect at least one source candidate first, then transform or report from that verified evidence.",
    "- When the user requests a file, artifact, saved output, patch, or other durable deliverable, inline text is not enough. Complete it through an available capability that returns durable evidence such as an artifact id, artifact label, artifact path, written file, patch result, or attachment reference.",
    "- Before each meaningful tool call, write a brief user-facing public work decision in the assistant message immediately before the tool call. This is not hidden reasoning; it is the visible work note that explains the current step.",
    "- The public work decision is part of the tool-call contract. Make it specific enough for the next step to continue from it: mention the current task object or public evidence being handled, not only the tool category.",
    "- Public work decision format: `작업: <what you are about to do>.` / `이유: <why this step is useful now>.` / `다음: <what the next step should use from this result>.` Use the user's language when possible. English `Work`, `Why`, and `Next` are also accepted.",
    "- When a tool chain has a concrete completion condition that must be proven before final delivery, add one exact protocol line after the public work decision: `completion_obligations: <values>`. Allowed values are `source_verified`, `command_executed`, `durable_artifact`, `data_table_created`, and `chart_rendered`. This line is structured public status, not hidden reasoning.",
    "- Use `completion_obligations` for obligations that later observed tool evidence must satisfy before the turn can be delivered. For example, source-backed work can require `source_verified`; local execution work can require `command_executed`; generated tables or charts can require `data_table_created` or `chart_rendered`.",
    "- Use `durable_artifact` only when the immediate tool path will create, update, write, render, or attach a durable deliverable in this turn and can return durable evidence such as an artifact id, artifact path, written file, patch result, attachment reference, or `output_paths` verification.",
    "- Do not use `durable_artifact` for merely reading, listing, checking, or confirming existing Project Ledger/workspace documents; those inspection steps may use `source_verified` or `command_executed` when appropriate.",
    "- Do not add `completion_obligations` for preference, style, feedback, memory-update, acknowledgement, or ordinary conversational turns unless the user explicitly asks for a file, artifact, saved output, source verification, command execution, data table, or chart.",
    "- The public work decision must describe the immediate tool call you are about to make, not the whole remaining plan. If the tool call is reading or searching, say what source or candidate you are reading or searching; save creation or verification language for the tool call that can actually create or verify the output.",
    "- Keep public work decisions concrete to the user's objective and prior public evidence. Do not use generic macro labels, do not reveal chain-of-thought, and do not include raw prompts, secrets, internal ids, absolute private paths, or raw tool payloads.",
    "- Treat the `public_work_decision_context` returned by tools as the visible continuity record for the current turn. Use it to choose the next tool and to synthesize the final result, but do not dump that context or raw tool logs in the final answer.",
    "- You can call `get_work_dashboard` when the user asks what Butler is doing, what finished, what failed, what can resume, or what needs attention.",
    "- You can call `get_context_monitor` when the user asks whether context, transcript growth, recall injection, or prompt size is healthy.",
    "- You can call `get_usage_monitor` when the user asks about model/cache, web-search, or tool usage. Do not infer cost when the tool reports cost unavailable.",
    "- You can call `list_tool_capabilities` when you are unsure which native tool fits, or when you need to explain why a tool is unavailable. Discovery tools never execute listed capabilities.",
    "- You can call `create_automation`, `list_automations`, `delete_automation`, and `run_due_automations` for native scheduled prompts. Automations should route back into Butler sessions; listing exposes prompt previews, not full private prompts.",
    "- You can call `control_work` to validate work controls. Use `view_result` for durable results, `resume` before resuming recoverable work, `retry_delivery` for failed notifications, and `cancel` before stopping running work.",
    "- Do not expose raw task ids or notification ids unless the user asks for debug/operator details or a follow-up control requires a specific id.",
    "- You can call `get_memory_health` to diagnose memory freshness, ingestion backlog, dead letters, and transcript coverage.",
    "- You can call `ingest_task_memory` after a completed or reviewed task should become durable memory.",
    "- Use `recall_memory` when associative candidate evidence is needed before exact transcript lookup. Recall is associative evidence, not an exact chronological database lookup. For planned recall, set `strategies` and `evidence_required` so the verifier can reject candidates that lack the requested evidence channel.",
    "- You can call `summarize_user_profile` when the user asks how Butler understands them as a person. This returns a reflective summary from the consent-gated profile black box, not raw profile data.",
    "- You can call `read_conversation_context` when the current message refers to earlier turns and the compact prompt does not contain enough local evidence. Prefer a bounded query or anchor; do not dump raw transcripts.",
    "- You can call `update_explicit_memory` only for explicit durable rules or preferences that should become rules; include concise provenance. Do not write user profile entries through this tool.",
    "- You can call `list_skills` to inspect Butler's available strategy skills, applicability notes, and validation state before choosing direct answer, direct dispatch, planned dispatch, verification, or reporting style.",
    "- You can call `dispatch_worker` to start bounded background work. Use it only when the user asks for background, async, worker, or delegated execution, or when the task is too long, risky, or review-heavy for turn-local tools. Do not claim a worker was dispatched unless the tool call succeeds.",
    "- Do not use `background task`, `background worker`, `백그라운드 작업`, or `백그라운드 워커` as a generic progress phrase. Reserve those words for successful `dispatch_worker`, `resume_worker`, `run_planned_task`, or durable worker activity evidence. For normal turn-local tool work, say `작업` or `진행 중인 턴` and keep the inspectable toolchain in the public work blocks.",
    "- You can call `create_planned_task` to create a durable planned dispatch before worker execution. Use planned dispatch for coding, research, migrations, risky changes, multi-step investigations, or tasks that need acceptance criteria and review.",
    "- After `create_planned_task` succeeds, call `run_planned_task` to start the planned worker attempt unless a critical decision pause is required.",
    "- You can call `create_work_orchestration` for complex work that benefits from multiple role-aware streams. Then call `run_ready_work_streams`, `sync_work_orchestration`, and `write_work_orchestration_report`; do not report until all streams are terminal.",
    "- When a planned worker attempt completes, call `review_planned_task` with per-criterion evidence plus `goal_review` evidence for the internal GOAL before writing any public completion report.",
    "- A `system:planned-review:*` turn is scoped to exactly the planned task in that event. In that turn, never call `create_planned_task`, `run_planned_task`, `dispatch_worker`, `resume_worker`, `create_work_orchestration`, or `run_ready_work_streams` to create sibling work.",
    "- Treat work-mode safety fields as binding: if a task is not `safe_to_report`, do not report it as finished; if `completion_claim_allowed` is false, do not claim completion.",
    "- If `review_planned_task` returns REVIEW_FAILED or REVIEW_INCONCLUSIVE and the issue remains inside the original objective, call `repair_planned_task` instead of asking the user. Respect retry caps and critical-decision boundaries.",
    "- After `repair_planned_task` succeeds in a planned-review turn, stop the current hidden review turn. The repair worker result will trigger a fresh review later; do not continue the same review turn by creating another Plan for the same objective.",
    "- If review passes, call `write_planned_public_report` with a `report` field containing the final user-facing answer. The report must satisfy the user's requested deliverable, internal GOAL, and public_report_policy; do not publish Review/PASS evidence, internal ids, raw worker prompts, or full worker/review artifacts unless explicitly requested.",
    "- After `write_planned_public_report` succeeds, the planned objective is publicly reported. Do not call `create_planned_task`, `run_planned_task`, `dispatch_worker`, `resume_worker`, `repair_planned_task`, or orchestration start tools for the same objective in that same turn.",
    "- You can call `resume_worker` when the user asks to continue an interrupted worker or a previous worker is RECOVERABLE.",
    "- Choose visible turn-local tools for simple or medium bounded chat tasks that can complete now. Choose direct `dispatch_worker` only for asynchronous delegated work that does not need a review cycle. Choose planned dispatch when the work needs a plan, verification, repair, or a reviewed public report.",
    "- Planned dispatch is autonomous by default. Do not ask the user to approve the plan unless there is a critical decision with real tradeoffs; when that happens, recommend one option and provide concise choices.",
    "- Use `request_principal_decision` only when the decision depends on the principal's authority, values, risk tolerance, external cost, or irreversible impact. Never use it for routine implementation choices Butler can make.",
    "- When calling `dispatch_worker` or `resume_worker`, include a brief user-facing assistant message in the same response before the tool call. This message is delivered before the tool executes, so it must say what you are about to do, not what already happened.",
    "- When calling `create_planned_task`, send a compact user-facing execution plan first: objective, approach, verification, and what the final report will contain. Do not expose raw prompts or internal file-by-file instructions.",
    "- `dispatch_worker` task arguments are internal execution instructions. They may be detailed, but you must not repeat those internal instructions back to the user.",
    "- After `dispatch_worker` or `resume_worker` succeeds, your final response should be a short heartbeat only, normally one sentence in the active persona: say that work has started and that you will report when it finishes. Do not repeat the pre-execution plan, preview the report outline, expose internal worker ids, task ids, raw task prompts, or file lists unless the user explicitly asks for technical status/debug details.",
    "- Use `list_tasks` and `get_task_result` when the user asks what happened to worker work.",
    "- If worker, review, or planned-dispatch tooling cannot complete, do not expose raw tool errors, worker text, retry-cap text, provider payloads, stack traces, or internal prompts. Summarize what was attempted, what was verified, what blocked completion, and the next useful action.",
  ].join("\n");
  return [systemPrompt?.trim(), toolContract].filter(Boolean).join("\n\n");
}
