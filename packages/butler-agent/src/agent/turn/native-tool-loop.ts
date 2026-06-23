import { randomUUID } from "crypto";
import type {
  AgentRuntimeAdapter,
  RuntimeSessionHandle,
  RuntimeSessionInit,
  RuntimeTurnInput,
  RuntimeTurnResult,
  SessionRole,
} from "../../test-support/harness/contracts.ts";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../test-support/harness/transcripts.ts";
import {
  runFunctionToolPromptText,
  runPromptText,
  type FunctionToolPromptOptions,
  type PromptUsageAttribution,
} from "../../integrations/providers/provider.ts";
import type { WebSearchProvider } from "../../integrations/search/provider.ts";
import {
  BUTLER_TOOLS,
  createButlerToolExecutor,
  satisfiedCompletionObligationsForToolResult,
} from "../tools/butler-tools.ts";
import {
  DIRECT_TOOL_CHAIN_MAX_ROUNDS,
  RepeatedToolFamilyGuard,
  directToolRoundLimit,
} from "./tool-loop-guards.ts";
import { completedToolProgressSummary } from "./native-completed-tool-progress.ts";
import { createProjectLedgerFreshnessCache } from "./native-project-ledger-freshness-cache.ts";
import { applyPlannedReviewToolPolicy } from "./native-planned-review-tool-policy.ts";
import {
  createAuditedBridgeToolExecutor,
  type BridgedToolCallAuditContext,
  withBridgeInvocationForAudit,
} from "./bridge-tool-executor.ts";
import {
  ToolSurfacePromptController,
} from "./tool-surface-prompt-controller.ts";
import {
  appendButlerToolInstructions,
  appendRoleToolPolicyInstructions,
} from "./native-tool-instructions.ts";
import {
  addDirectTurnUsage,
  beforeDirectTurnModelRequest,
  createDirectTurnBudget,
  directTurnBudgetState,
  promptUsageSectionsFromPrompt,
  recentConversationBudgetForTurn,
} from "./direct-turn-budget.ts";
import {
  activeDirectWorkProgressSnapshot,
  directWorkSemanticProgressAdvanced,
  finalDeliveryBlockerForOpenDirectWork,
  openDirectWorkContinuationPrompt,
  RUNTIME_SEMANTIC_TODO_LIST_ID,
  turnAdvancedDuringToolPrompt,
  type DirectWorkProgressSnapshot,
} from "./direct-work-continuation.ts";
import { runtimeArtifactsFromAudit } from "./native-runtime-artifacts.ts";
import {
  plannedReviewTurnContext,
  type PlannedReviewTurnContext,
} from "./native-planned-review-context.ts";
import {
  renderRecallContext,
  shouldAttemptAutomaticRecall,
} from "./native-recall-context.ts";
import {
  getButlerData,
  getButlerHome,
} from "./native-runtime-paths.ts";
import {
  currentInboundEventId,
  currentRuntimeTurnId,
  currentUserText,
  inboundAttachments,
  normalizeTurnPrompt,
  promptContextIncludesSection,
  promptContextSection,
  type NormalizedTurnPrompt,
} from "./native-turn-prompt.ts";
import {
  activeTodoWorkBlockFromArgs,
  isInternalProgressTool,
  runtimeSemanticTodoItems,
  shouldSynthesizeRuntimeSemanticProgress,
  WORKER_ORCHESTRATION_START_TOOL_SET,
} from "./native-runtime-semantic-progress.ts";
import {
  buildIntermediateAction,
  emitDecisionProgressBestEffort,
  emitIntermediateBestEffort,
  emitRuntimePreparationProgressBestEffort,
  emitTodoProgressBestEffort,
  emitTurnEventBestEffort,
} from "./native-turn-delivery-events.ts";
import {
  plannedReviewTerminalToolText,
  publicReportFromToolOutput,
  taskIdFromToolResult,
} from "./native-tool-result-text.ts";
import {
  bridgeToolAuditEvent,
  redactedBridgeToolAuditArgs,
  redactedBridgeToolAuditResult,
} from "../tools/tool-bridge/audit.ts";
import { buildTaskOriginContext } from "../work/task-origin.ts";
import { TaskStore } from "../work/task-store.ts";
import { TodoListStore } from "../work/todo-list.ts";
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
import { sanitizePublicText } from "../events/turn-events.ts";
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
  evidenceTranscriptErrorMessage,
  evidenceTranscriptToolCallArgumentsProjection,
  evidenceTranscriptToolResultProjection,
} from "../output/evidence-transcript-result.ts";
import {
  CompletionReviewOrchestrator,
} from "./completion-review-orchestrator.ts";
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
export { recentConversationBudgetForTurn } from "./direct-turn-budget.ts";

export interface NativeToolLoopRuntimeOptions {
  runPromptText?: typeof runPromptText;
  runFunctionToolPromptText?: typeof runFunctionToolPromptText;
  executeButlerTool?: FunctionToolPromptOptions["executeTool"];
  butlerHome?: string;
  butlerData?: string;
  appMessageDbPath?: string;
  messageLanguage?: RuntimeMessageLanguage;
  webSearchProvider?: WebSearchProvider;
  recallMemory?: typeof recallMemory;
  recallMemoryWithVector?: typeof recallMemoryWithVector;
  disableAutomaticRecall?: boolean;
  contextBudgetOverrides?: ContextBudgetOverrides;
  recentConversationTokenBudget?: number;
}

// Keep automatic recall within the same latency envelope as vector.ts' default search budget.
const AUTOMATIC_RECALL_VECTOR_TIMEOUT_MS = 1_500;
const GOAL_COMPLETION_REVIEW_SKIP_TOOLS = new Set([
  "dispatch_worker",
  "resume_worker",
  "run_planned_task",
  "repair_planned_task",
  "run_ready_work_streams",
  "write_planned_public_report",
  "write_work_orchestration_report",
]);
const DEFAULT_GOAL_COMPLETION_CONTINUATION_ATTEMPTS = 8;
const DEFAULT_DIRECT_WORK_CONTINUATION_ATTEMPTS = 100;

interface StoredSessionConfig {
  init: RuntimeSessionInit;
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

function throwIfRuntimeTurnAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw runtimeTurnAbortError();
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

function runtimePreparationProgressSummary(input: {
  prompt: NormalizedTurnPrompt;
  attachmentContextChars: number;
  attachmentCount: number;
  model: string;
  language: RuntimeMessageLanguage;
  useTools: boolean;
}): ToolProgressSummary {
  const ko = input.language === "ko";
  const safeLabel = ko
    ? "응답 준비 중"
    : "Preparing response";
  return {
    kind: "model",
    toolName: ko ? "모델 준비" : "Model preparation",
    safeLabel,
    workBlockLabel: safeLabel,
    inputLabel: "",
    detailRows: [],
  };
}

function discardPendingPublicDecisionForTool(
  pending: PublicWorkDecision[],
  toolName: string,
): void {
  const index = pending.findIndex((decision) => decision.toolName === toolName);
  if (index >= 0) pending.splice(index, 1);
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
  private readonly webSearchProvider?: WebSearchProvider;
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
    this.webSearchProvider = options.webSearchProvider;
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

    const useTools = session.init.role === "butler" || session.init.role === "steward" || session.init.role === "worker";

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
      await emitRuntimePreparationProgressBestEffort({
        turnInput: input,
        progress: runtimePreparationProgressSummary({
          prompt: normalizedPrompt,
          attachmentContextChars: currentAttachmentContext.length,
          attachmentCount: attachments.length,
          model: input.model,
          language: this.messageLanguage,
          useTools,
        }),
      });
      const toolSurfaceController = new ToolSurfacePromptController({
        role: session.init.role,
        sessionMetadata: session.init.metadata,
        turnMetadata: input.metadata,
        providerCapabilities: input.provider.capabilities,
        tools: BUTLER_TOOLS,
        providerSupportsSchemaPromotion:
          input.provider.capabilities.supportsSameTurnToolSchemaPromotion === true,
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
        toolSurfaceController,
        executor: this.butlerToolExecutor ?? createButlerToolExecutor({
          butlerHome: this.butlerHome,
          butlerData: this.butlerData,
          appMessageDbPath: this.appMessageDbPath,
          workspacePath: session.init.workspacePath,
          sessionId: input.handle.sessionId,
          projectId: typeof session.init.metadata?.projectId === "string" ? session.init.metadata.projectId : undefined,
          turnId: currentRuntimeTurnId(input) ?? undefined,
          workerModel: input.model,
          webSearchProvider: this.webSearchProvider,
          searchPlannerModel: input.model,
          searchPlannerOriginalRequest: userText,
          workerModelRules: workerModelRulesFromMetadata(input.metadata?.workerModelRules ?? session.init.metadata?.workerModelRules),
          turnContext: [prompt, currentAttachmentContext].filter(Boolean).join("\n\n"),
          currentToolNames: () => toolSurfaceController.currentToolNames(),
          describedToolIds: () => toolSurfaceController.describedToolIdList(),
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
        return await toolSurfaceController.runWithSelectedSurface(async (toolSurface) => {
          return await this.toolPromptRunner({
            prompt: promptText,
            model: input.model,
            instructions: appendRoleToolPolicyInstructions(session.init.role, appendButlerToolInstructions(session.init.systemPrompt)),
            cacheScope: "session-turn",
            signal: input.signal,
            attachments,
            tools: toolSurface.tools,
            dynamicTools: toolSurface.dynamicTools,
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
        });
      };
      const successfulToolAuditCount = () => audit.filter((entry) => entry.ok).length;
      const runGoalCompletionReviewGate = async (
        currentFinalText: string,
        reviewPromptText: string,
        maxToolRounds: number,
      ): Promise<string> => {
        const outcome = await new CompletionReviewOrchestrator<DirectWorkProgressSnapshot>().run({
          currentFinalText,
          initialReviewPromptText: reviewPromptText,
          reviewMaxToolRounds: maxToolRounds,
          continuationMaxToolRounds: 8,
          maxContinuationAttempts: goalCompletionContinuationAttempts(),
          runToolPrompt,
          incompleteReason: completionReviewIncompleteReason,
          buildContinuationPrompt: ({ previousAnswer, incompleteReason }) =>
            goalCompletionIncompleteContinuationPrompt({
              prompt,
              previousAnswer,
              incompleteReason,
              audit,
              decisions: publicDecisionContext,
            }),
          buildReviewPrompt: ({ candidateFinalText }) => goalCompletionReviewPrompt({
            prompt,
            previousAnswer: candidateFinalText,
            audit,
            decisions: publicDecisionContext,
          }),
          captureProgress: () => ({
            progress: activeDirectWorkProgressSnapshot({
              butlerData: this.butlerData,
              sessionId: input.handle.sessionId,
            }),
            successfulToolCount: successfulToolAuditCount(),
          }),
          didProgressAdvance: (before, after) => turnAdvancedDuringToolPrompt({
            beforeWork: before.progress,
            afterWork: after.progress,
            successfulToolsBefore: before.successfulToolCount,
            successfulToolsAfter: after.successfulToolCount,
          }),
        });
        if (outcome.kind === "deliverable") {
          return outcome.text;
        }
        throw goalCompletionIncompleteError(outcome.reason);
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
        const explicitTools = requiredExplicitToolNames(
          [session.init.metadata, input.metadata],
          toolSurfaceController.initialToolNames(),
        );
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
          const workBeforeContinuation = activeDirectWorkProgressSnapshot({
            butlerData: this.butlerData,
            sessionId: input.handle.sessionId,
          });
          finalText = await runToolPrompt(openDirectWorkContinuationPrompt({
            objective: userText,
            personaContext: promptContextSection(
              typeof input.metadata?.promptContext === "string" ? input.metadata.promptContext : "",
              "Active Persona Reminder",
            ),
            audit,
            blocker,
          }), 8, "direct_work_continuation");
          const workAfterContinuation = activeDirectWorkProgressSnapshot({
            butlerData: this.butlerData,
            sessionId: input.handle.sessionId,
          });
          if (!directWorkSemanticProgressAdvanced(workBeforeContinuation, workAfterContinuation)) break;
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
  toolSurfaceController?: ToolSurfacePromptController;
  executor: FunctionToolPromptOptions["executeTool"];
}): FunctionToolPromptOptions["executeTool"] {
  let semanticProgressEstablished = false;
  let currentSemanticWorkBlock: { id: string; label: string } | null = null;
  const projectLedgerFreshnessCache = createProjectLedgerFreshnessCache(input.executor);
  const repeatedToolFamilyGuard = new RepeatedToolFamilyGuard();
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
        arguments: evidenceTranscriptToolCallArgumentsProjection(cleanArgs),
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
          result: evidenceTranscriptToolResultProjection(result),
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
          error: evidenceTranscriptErrorMessage(message),
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
  const executeAuditedTarget = async (
    call: Parameters<FunctionToolPromptOptions["executeTool"]>[0],
    bridgedFrom?: BridgedToolCallAuditContext,
  ): Promise<unknown> => {
    const startedAt = Date.now();
    const cleanArgs = { ...call.args };
    const inboundEnvelope = "eventId" in input.turnInput.input ? input.turnInput.input : null;
    if (isInternalProgressTool(call.name)) {
      return await runInternalProgressTool(call, "model");
    }
    const plannedReviewBlock = applyPlannedReviewToolPolicy({
      plannedReview: input.plannedReview,
      toolName: call.name,
      args: cleanArgs,
    });
    if (plannedReviewBlock) {
      input.audit.push({
        name: call.name,
        args: cleanArgs,
        ok: false,
        error: plannedReviewBlock.error,
      });
      appendTranscriptEvent(createTranscriptEvent({
        sessionId: input.sessionId,
        kind: "tool_result",
        payload: {
          name: call.name,
          ok: false,
          error: evidenceTranscriptErrorMessage(plannedReviewBlock.error),
          planned_review_task_id: plannedReviewBlock.reviewTaskId,
        },
        metadata: {
          source: "runtime/native-tool-loop.ts#planned-review-policy",
        },
      }));
      return plannedReviewBlock.result;
    }
    const repeatDecision = repeatedToolFamilyGuard.record(call.name, cleanArgs);
    if (repeatDecision?.blocked) {
      const result = repeatDecision.result;
      appendTranscriptEvent(createTranscriptEvent({
        sessionId: input.sessionId,
        kind: "tool_call",
        payload: {
          name: call.name,
          arguments: evidenceTranscriptToolCallArgumentsProjection(cleanArgs),
        },
        metadata: {
          source: "runtime/native-tool-loop.ts#repeated-tool-family-guard",
          repeat_family: repeatDecision.family,
        },
      }));
      appendTranscriptEvent(createTranscriptEvent({
        sessionId: input.sessionId,
        kind: "tool_result",
        payload: {
          name: call.name,
          ok: false,
          result: evidenceTranscriptToolResultProjection(result),
        },
        metadata: {
          source: "runtime/native-tool-loop.ts#repeated-tool-family-guard",
          repeat_family: repeatDecision.family,
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
          repeatFamily: repeatDecision.family,
          repeatCount: String(repeatDecision.count),
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
        arguments: evidenceTranscriptToolCallArgumentsProjection(cleanArgs),
      },
      metadata: {
        source: "runtime/native-tool-loop.ts",
      },
    }));
    try {
      throwIfRuntimeTurnAborted(input.turnInput.signal);
      const result = await projectLedgerFreshnessCache.execute(effectiveCall);
      if (call.name === "tool_describe") {
        input.toolSurfaceController?.recordToolDescriptionResult(result);
      }
      throwIfRuntimeTurnAborted(input.turnInput.signal);
      repeatedToolFamilyGuard.resetAfterStateMutation(call.name, cleanArgs);
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
      const bridgeAuditName = bridgedFrom ? "tool_call" : call.name;
      const bridgeAuditArgs = bridgedFrom?.args ?? cleanArgs;
      const bridgeAuditResult = bridgedFrom
        ? withBridgeInvocationForAudit(result, bridgedFrom.invocation)
        : result;
      const bridgeAudit = bridgeToolAuditEvent(bridgeAuditName, bridgeAuditArgs, bridgeAuditResult);
      input.audit.push({
        name: call.name,
        args: bridgeAudit && !bridgedFrom ? redactedBridgeToolAuditArgs(call.name, cleanArgs) : cleanArgs,
        ok: true,
        result: bridgeAudit && !bridgedFrom ? redactedBridgeToolAuditResult(call.name, result) : result,
        publicDecision: decision,
        satisfiedCompletionObligations: satisfiedCompletionObligationsForToolResult(call.name, result),
        evidenceReceipts: evidenceReceiptsFromResult(result),
        bridgeAudit: bridgeAudit ?? undefined,
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
          result: evidenceTranscriptToolResultProjection(result),
          publicDecision: publicWorkDecisionPayload(decision),
        },
        metadata: {
          source: "runtime/native-tool-loop.ts",
          bridge_audit: bridgeAudit ?? undefined,
        },
      }));
      return modelVisibleResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      projectLedgerFreshnessCache.invalidateAfterTool(effectiveCall);
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
      const bridgeAudit = bridgedFrom
        ? bridgeToolAuditEvent("tool_call", bridgedFrom.args, {
          ok: false,
          error: {
            code: "underlying_tool_error",
            recoverable: false,
          },
          bridge_invocation: bridgedFrom.invocation,
        })
        : bridgeToolAuditEvent(call.name, cleanArgs, {
          ok: false,
          error: {
            code: "underlying_tool_error",
            recoverable: false,
          },
        });
      input.audit.push({
        name: call.name,
        args: bridgeAudit && !bridgedFrom ? redactedBridgeToolAuditArgs(call.name, cleanArgs) : cleanArgs,
        ok: false,
        error: message,
        publicDecision: decision,
        bridgeAudit: bridgeAudit ?? undefined,
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
          error: evidenceTranscriptErrorMessage(message),
          publicDecision: publicWorkDecisionPayload(decision),
        },
        metadata: {
          source: "runtime/native-tool-loop.ts",
          bridge_audit: bridgeAudit ?? undefined,
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
  const executeAuditedWithBridge = createAuditedBridgeToolExecutor({
    sessionId: input.sessionId,
    audit: input.audit,
    turnInput: input.turnInput,
    messageLanguage: input.messageLanguage,
    executor: input.executor,
    buildIntermediateAction,
    emitIntermediateBestEffort,
    emitTurnEventBestEffort,
    throwIfAborted: () => throwIfRuntimeTurnAborted(input.turnInput.signal),
    executeTarget: executeAuditedTarget,
  });
  const executeAudited: FunctionToolPromptOptions["executeTool"] = async (call) => {
    return await executeAuditedWithBridge(call);
  };
  return executeAudited;
}
