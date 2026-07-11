import { randomUUID } from "crypto";
import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import { BUTLER_TOOLS, createButlerToolExecutor } from "../../../tools/butler-tools.ts";
import { ToolSurfacePromptController } from "../../tool-surface-prompt-controller.ts";
import {
  createDirectTurnBudget,
  directTurnBudgetState,
  hydrateDirectTurnBudget,
  promptUsageSectionsFromPrompt,
  recentConversationBudgetForTurn,
} from "../../direct-turn-budget.ts";
import {
  createTurnContextAtomId,
  readTurnContextAtom,
} from "../../turn-continuation-context.ts";
import { RUNTIME_SEMANTIC_TODO_LIST_ID } from "../../direct-work-continuation.ts";
import { plannedReviewTurnContext } from "../context/planned-review-context.ts";
import { renderRecallContext, shouldAttemptAutomaticRecall } from "../context/recall-context.ts";
import {
  currentInboundEventId,
  currentRuntimeTurnId,
  currentUserText,
  inboundAttachments,
  normalizeTurnPrompt,
  promptContextIncludesSection,
} from "../context/turn-prompt.ts";
import { createAuditedButlerToolExecutor } from "../tool-execution/audited-tool-executor.ts";
import type { RuntimeSemanticProgressSafetyNet } from "../tool-execution/audited-executor-types.ts";
import {
  emitRuntimePreparationProgressBestEffort,
  emitTurnEventBestEffort,
} from "../progress/turn-delivery-events.ts";
import { renderFeedbackBufferContext } from "../../../cognition/feedback/buffer.ts";
import {
  defaultRecentConversationTokenBudget,
} from "../../../context/budget.ts";
import { renderAttachmentContext } from "../../../context/attachment-context.ts";
import {
  maybeAutoCompactSession,
} from "../../../context/compaction.ts";
import {
  refreshWorkingMemoryFromTranscript,
  renderWorkingMemoryContext,
} from "../../../context/working-memory.ts";
import type { PublicWorkDecision, ToolAuditEntry } from "../output/tool-types.ts";
import {
  loadSessionContextPolicyCatalog,
  renderSessionContextPolicyContext,
} from "../../../policy/session-context-policy.ts";
import { workerModelRulesFromMetadata } from "../policy/turn-metadata-policy.ts";
import { runtimePreparationProgressSummary } from "./runtime-preparation-progress.ts";
import {
  recordContextMetric,
  recordTurnContextBestEffortFailure,
} from "./context-metrics.ts";
import type { NativeTurnRunnerDeps, NativeStoredSessionConfig } from "./turn-runner-types.ts";
import {
  recordFirstVisibleLatencyMetric,
  type TurnPreparationStep,
} from "../../../../operations/metrics/first-visible-latency.ts";
import {
  measureTurnPreparationStep,
  measureTurnPreparationStepSync,
  recordTurnPreparationStepSkipped,
  type TurnPreparationMetricContext,
} from "../../preparation-metrics.ts";
import type { FunctionToolPromptOptions } from "../../../../integrations/providers/provider.ts";
import { WORK_TRACKING_TOOL_NAMES } from "../../../tools/work-tracking/shared.ts";
import { selectWorkStreamCheckpointResume } from "../../workstream-checkpoint-resume-controller.ts";
import {
  buildFocusedResumeEnvelope,
  turnMetadataWithFocusedResumePolicy,
} from "../../workstream-focused-resume-envelope.ts";
import {
  buildWorkStreamResumeDecisionEnvelope,
  turnMetadataWithResumeDecisionPolicy,
} from "../../workstream-resume-decision-envelope.ts";

const TURN_SCOPED_WORK_TRACKING_TOOLS = new Set<string>(WORK_TRACKING_TOOL_NAMES);

export async function prepareNativeTurnContext(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
  startedAt: number;
  useTools: boolean;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
  pendingPublicDecisions: PublicWorkDecision[];
  assistantTextBeforeToolsSeen: () => boolean;
  activeWorkStreamBinding: () => { contractId: string; workStreamId: string } | null;
  skipRuntimePreparationProgress?: boolean;
}) {
  const userText = currentUserText(input.turnInput);
  const plannedReview = plannedReviewTurnContext(input.turnInput);
  await maybeCompact(input);
  const turnId = currentRuntimeTurnId(input.turnInput) ?? `turn-${randomUUID().slice(0, 12)}`;
  const continuationAtom = hasSchedulerContinuationMetadata(
    input.turnInput,
    input.turnInput.handle.sessionId,
    turnId,
  )
    ? readTurnContextAtom({
      butlerData: input.deps.butlerData,
      sessionId: input.turnInput.handle.sessionId,
      turnId,
    })
    : null;
  const chatId = currentChatId(input.turnInput);
  const resumeSelection = selectWorkStreamCheckpointResume({
    butlerData: input.deps.butlerData,
    sessionId: input.turnInput.handle.sessionId,
    chatId,
    projectId: projectId(input.session),
    currentTurnId: turnId,
    turnMetadata: input.turnInput.metadata,
    userText,
  });
  const focusedResumeEnvelope = buildFocusedResumeEnvelope({
    butlerData: input.deps.butlerData,
    selection: resumeSelection,
    currentUserText: userText,
  });
  const resumeDecisionEnvelope = buildWorkStreamResumeDecisionEnvelope({
    selection: resumeSelection,
    currentUserText: userText,
  });
  const effectiveTurnMetadata = turnMetadataWithResumeDecisionPolicy(
    turnMetadataWithFocusedResumePolicy(
      input.turnInput.metadata,
      focusedResumeEnvelope,
    ),
    resumeDecisionEnvelope,
  );
  const recallContext = focusedResumeEnvelope
    ? skipAutomaticRecallForFocusedResume(input)
    : await maybeRecall(input, userText);
  const compactionContext = measureTurnPreparationStepSync(
    preparationMetricInput(input, "compaction_context"),
    () => "",
  );
  const feedbackContext = measureTurnPreparationStepSync(
    preparationMetricInput(input, "feedback_buffer"),
    () => feedbackBufferContext(input, compactionContext),
  );
  const memoryContext = measureTurnPreparationStepSync(
    preparationMetricInput(input, "working_memory"),
    () => workingMemoryContext(input),
  );
  const runtimePolicyContext = measureTurnPreparationStepSync(
    preparationMetricInput(input, "runtime_policy"),
    () => renderSessionContextPolicyContext({
      catalog: loadSessionContextPolicyCatalog(input.deps.butlerHome),
      session: input.session.init,
    }),
  );
  const normalizedPrompt = measureTurnPreparationStepSync(
    preparationMetricInput(input, "prompt_normalization"),
    () => normalizeTurnPrompt(input.turnInput, {
      recallContext,
      compactionContext,
      feedbackBufferContext: feedbackContext,
      workingMemoryContext: memoryContext,
      runtimePolicyContext,
      focusedResumeEnvelope: focusedResumeEnvelope?.prompt,
      resumeDecisionEnvelope: resumeDecisionEnvelope?.prompt,
      removePromptContextSections: focusedResumeEnvelope
        ? ["Active Work State", "Project Ledger Runtime Context"]
        : [],
      skipRecentConversation: Boolean(focusedResumeEnvelope),
      recentConversationTokenBudget: recentConversationBudgetForTurn({
        configuredBudget: input.deps.recentConversationTokenBudget ??
          defaultRecentConversationTokenBudget(input.turnInput.model),
        compactionContext,
      }),
      butlerData: input.deps.butlerData,
    }),
  );
  const attachments = inboundAttachments(input.turnInput);
  const turnBudget = budgetForTurn({
    butlerData: input.deps.butlerData,
    sessionId: input.turnInput.handle.sessionId,
    turnId,
    turnInput: input.turnInput,
    resumeSelection,
    continuationAtom,
  });
  const currentAttachmentContext = measureTurnPreparationStepSync(
    preparationMetricInput(input, "attachment_context"),
    () => renderAttachmentContext(attachments, {
      butlerData: input.deps.butlerData,
      title: "Inbound Attachments",
      maxAttachmentTextChars: 18_000,
      maxTotalTextChars: 36_000,
    }),
  );
  const toolSurfaceController = new ToolSurfacePromptController({
    role: input.session.init.role,
    message: userText,
    sessionMetadata: input.session.init.metadata,
    turnMetadata: effectiveTurnMetadata,
    providerCapabilities: input.turnInput.provider.capabilities,
    tools: BUTLER_TOOLS,
    providerSupportsSchemaPromotion:
      input.turnInput.provider.capabilities.supportsSameTurnToolSchemaPromotion === true,
  });
  const semanticProgressSafetyNet = semanticProgressSafetyNetFor(input.deps.messageLanguage);
  const prompt = normalizedPrompt.prompt;
  const defaultExecutor = createButlerToolExecutor({
    butlerHome: input.deps.butlerHome,
    butlerData: input.deps.butlerData,
    appMessageDbPath: input.deps.appMessageDbPath,
    workspacePath: input.session.init.workspacePath,
    sessionId: input.turnInput.handle.sessionId,
    originChatId: chatId ?? undefined,
    projectId: projectId(input.session),
    turnId,
    workerModel: input.turnInput.model,
    webSearchProvider: input.deps.webSearchProvider,
    searchPlannerModel: input.turnInput.model,
    searchPlannerOriginalRequest: userText,
    workerModelRules: workerModelRulesFromMetadata(
      effectiveTurnMetadata?.workerModelRules ?? input.session.init.metadata?.workerModelRules,
    ),
    turnContext: [prompt, currentAttachmentContext].filter(Boolean).join("\n\n"),
    currentToolNames: () => toolSurfaceController.currentToolNames(),
    describedToolIds: () => toolSurfaceController.describedToolIdList(),
    activeWorkStreamBinding: input.activeWorkStreamBinding,
  });
  const executor = createAuditedButlerToolExecutor({
    sessionId: input.turnInput.handle.sessionId,
    turnId,
    audit: input.audit,
    publicDecisionContext: input.publicDecisionContext,
    pendingPublicDecisions: input.pendingPublicDecisions,
    assistantTextBeforeToolsSeen: input.assistantTextBeforeToolsSeen,
    turnInput: input.turnInput,
    butlerHome: input.deps.butlerHome,
    butlerData: input.deps.butlerData,
    appMessageDbPath: input.deps.appMessageDbPath,
    projectId: projectId(input.session),
    workspacePath: input.session.init.workspacePath,
    messageLanguage: input.deps.messageLanguage,
    plannedReview,
    semanticProgressSafetyNet,
    toolSurfaceController,
    activeWorkStreamBinding: input.activeWorkStreamBinding,
    executor: turnScopedExecutor({
      defaultExecutor,
      injectedExecutor: input.deps.butlerToolExecutor,
      signal: input.turnInput.signal,
    }),
  });
  await emitStartedAndPreparation({
    ...input,
    session: input.session,
    turnId,
    turnBudget,
    startedAt: input.startedAt,
    normalizedPrompt,
    currentAttachmentContext,
    userText,
    skipRuntimePreparationProgress: input.skipRuntimePreparationProgress === true,
  });
  recordContextMetric(input, normalizedPrompt, prompt);
  return {
    userText,
    plannedReview,
    chatId,
    turnId,
    turnBudget,
    prompt,
    normalizedPrompt,
    promptSections: promptUsageSectionsFromPrompt(normalizedPrompt),
    attachments,
    toolSurfaceController,
    executor,
    semanticProgressSafetyNet,
    resumeSelection,
    focusedResumeEnvelope,
    resumeDecisionEnvelope,
    continuationAtom,
  };
}

function skipAutomaticRecallForFocusedResume(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
}): string {
  recordTurnPreparationStepSkipped({
    ...preparationMetricInput(input, "automatic_recall"),
    skippedReason: "focused_resume",
  });
  return "";
}

function budgetForTurn(input: {
  butlerData: string;
  sessionId: string;
  turnId: string;
  turnInput: RuntimeTurnInput;
  resumeSelection: ReturnType<typeof selectWorkStreamCheckpointResume>;
  continuationAtom: ReturnType<typeof readTurnContextAtom>;
}) {
  if (!hasSchedulerContinuationMetadata(input.turnInput, input.sessionId, input.turnId)) {
    return hydrateDirectTurnBudget(
      input.turnId,
      input.resumeSelection.selected?.checkpoint.budgetSnapshot,
    );
  }
  return hydrateDirectTurnBudget(input.turnId, input.continuationAtom?.budgetSnapshot);
}

function currentChatId(input: RuntimeTurnInput): string | null {
  const envelope = input.input;
  if (!("eventId" in envelope)) return input.handle.sessionId;
  if (envelope.peer.kind === "thread") {
    return envelope.peer.parentId?.trim() || envelope.peer.id;
  }
  return envelope.peer.id;
}

function hasSchedulerContinuationMetadata(
  input: RuntimeTurnInput,
  sessionId: string,
  turnId: string,
): boolean {
  const metadata = input.metadata && typeof input.metadata === "object"
    ? input.metadata as Record<string, unknown>
    : {};
  const schedulerContinuation = metadata.schedulerContinuation;
  if (!schedulerContinuation || typeof schedulerContinuation !== "object") return false;
  const contextAtomId = (schedulerContinuation as { contextAtomId?: unknown }).contextAtomId;
  return contextAtomId === createTurnContextAtomId(sessionId, turnId);
}

function semanticProgressSafetyNetFor(language: NativeTurnRunnerDeps["messageLanguage"]):
  RuntimeSemanticProgressSafetyNet {
  return {
    source: null,
    listId: RUNTIME_SEMANTIC_TODO_LIST_ID,
    title: language === "ko" ? "진행 중인 작업" : "Current work",
    lastExecutionLabel: language === "ko"
      ? "필요한 도구 작업을 실행합니다."
      : "Run the needed tool work.",
  };
}

async function maybeCompact(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
}): Promise<void> {
  try {
    await measureTurnPreparationStep(
      preparationMetricInput(input, "context_compaction"),
      async () => {
        await maybeAutoCompactSession({
          butlerData: input.deps.butlerData,
          sessionId: input.turnInput.handle.sessionId,
          modelRef: input.turnInput.model,
          budgetOverrides: input.deps.contextBudgetOverrides,
        });
      },
    );
  } catch (error) {
    recordTurnContextBestEffortFailure(input, "turn_context_compaction_failed", error);
  }
}

async function maybeRecall(
  input: {
    turnInput: RuntimeTurnInput;
    session: NativeStoredSessionConfig;
    deps: NativeTurnRunnerDeps;
  },
  userText: string,
): Promise<string> {
  const automaticRecallEnabled = input.deps.automaticRecallEnabled;
  const shouldAttemptRecall = shouldAttemptAutomaticRecall(input.turnInput, userText);
  if (!automaticRecallEnabled || !shouldAttemptRecall) {
    recordTurnPreparationStepSkipped({
      ...preparationMetricInput(input, "automatic_recall"),
      skippedReason: automaticRecallEnabled ? "not_required" : "disabled",
    });
    return "";
  }
  try {
    const recall = await measureTurnPreparationStep(
      preparationMetricInput(input, "automatic_recall"),
      async () => await input.deps.runAutomaticRecall({
        butlerData: input.deps.butlerData,
        cue: userText,
        projectId: projectId(input.session),
        limit: 4,
      }),
    );
    return renderRecallContext(recall);
  } catch (error) {
    recordTurnContextBestEffortFailure(input, "turn_context_recall_failed", error);
    return "";
  }
}

function feedbackBufferContext(
  input: { turnInput: RuntimeTurnInput; deps: NativeTurnRunnerDeps },
  compactionContext: string,
): string {
  void compactionContext;
  return promptContextIncludesSection(input.turnInput, "Active Feedback Buffer")
    ? ""
    : renderFeedbackBufferContext({
      butlerData: input.deps.butlerData,
      sessionId: input.turnInput.handle.sessionId,
    });
}

function workingMemoryContext(input: {
  turnInput: RuntimeTurnInput;
  deps: NativeTurnRunnerDeps;
}): string {
  return renderWorkingMemoryContext(refreshWorkingMemoryFromTranscript({
    butlerData: input.deps.butlerData,
    sessionId: input.turnInput.handle.sessionId,
    excludeEventId: currentInboundEventId(input.turnInput),
  }));
}

async function emitStartedAndPreparation(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  turnId: string;
  turnBudget: ReturnType<typeof createDirectTurnBudget>;
  startedAt: number;
  normalizedPrompt: ReturnType<typeof normalizeTurnPrompt>;
  currentAttachmentContext: string;
  userText: string;
  skipRuntimePreparationProgress: boolean;
}): Promise<void> {
  await emitTurnEventBestEffort(input.turnInput, {
    kind: "turn.iteration.started",
    payload: {
      iteration: 1,
      model: input.turnInput.model,
      useTools: input.useTools,
      turnId: input.turnId,
      budget: directTurnBudgetState(input.turnBudget),
    },
  });
  if (input.skipRuntimePreparationProgress) {
    recordTurnPreparationStepSkipped({
      ...preparationMetricInput(input, "runtime_preparation_progress"),
      skippedReason: "early_runtime_preparation_progress_emitted",
    });
    return;
  }
  await measureTurnPreparationStep(
    preparationMetricInput(input, "runtime_preparation_progress"),
    async () => {
      await emitRuntimePreparationProgressBestEffort({
        turnInput: input.turnInput,
        progress: runtimePreparationProgressSummary({
          prompt: input.normalizedPrompt,
          attachmentContextChars: input.currentAttachmentContext.length,
          attachmentCount: inboundAttachments(input.turnInput).length,
          model: input.turnInput.model,
          language: input.deps.messageLanguage,
          useTools: input.useTools,
          userText: input.userText,
        }),
        emitPreparationWorkBlock: input.useTools,
      });
    },
  );
  recordFirstVisibleLatencyMetric({
    butlerData: input.deps.butlerData,
    durationMs: Date.now() - input.startedAt,
    signal: "runtime_preparation",
    role: input.turnInput.handle.role,
    runtime: input.deps.runtimeId,
    model: input.turnInput.model,
    source: "native-turn-runner",
  });
}

function preparationMetricInput(
  input: {
    turnInput: RuntimeTurnInput;
    session: NativeStoredSessionConfig;
    deps: NativeTurnRunnerDeps;
  },
  step: TurnPreparationStep,
): TurnPreparationMetricContext & { step: TurnPreparationStep } {
  return {
    butlerData: input.deps.butlerData,
    step,
    role: input.session.init.role,
    runtime: input.deps.runtimeId,
    model: input.turnInput.model,
  };
}

function turnScopedExecutor(input: {
  defaultExecutor: FunctionToolPromptOptions["executeTool"];
  injectedExecutor?: FunctionToolPromptOptions["executeTool"];
  signal?: AbortSignal;
}): FunctionToolPromptOptions["executeTool"] {
  const defaultExecutor = input.defaultExecutor;
  const injectedExecutor = input.injectedExecutor;
  return async (call) => {
    const scopedCall = input.signal ? { ...call, signal: input.signal } : call;
    if (!injectedExecutor) return await defaultExecutor(scopedCall);
    if (TURN_SCOPED_WORK_TRACKING_TOOLS.has(call.name)) {
      return await defaultExecutor(scopedCall);
    }
    return await injectedExecutor(call);
  };
}

function projectId(session: NativeStoredSessionConfig): string | undefined {
  const metadataProjectId = session.init.metadata?.projectId;
  if (typeof metadataProjectId !== "string") {
    return undefined;
  }
  return metadataProjectId;
}
