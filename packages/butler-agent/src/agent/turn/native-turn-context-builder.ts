import { randomUUID } from "crypto";
import type { RuntimeTurnInput } from "../../test-support/harness/contracts.ts";
import { BUTLER_TOOLS, createButlerToolExecutor } from "../tools/butler-tools.ts";
import { ToolSurfacePromptController } from "./tool-surface-prompt-controller.ts";
import {
  createDirectTurnBudget,
  directTurnBudgetState,
  promptUsageSectionsFromPrompt,
  recentConversationBudgetForTurn,
} from "./direct-turn-budget.ts";
import { RUNTIME_SEMANTIC_TODO_LIST_ID } from "./direct-work-continuation.ts";
import { plannedReviewTurnContext } from "./native-planned-review-context.ts";
import { renderRecallContext, shouldAttemptAutomaticRecall } from "./native-recall-context.ts";
import {
  currentInboundEventId,
  currentRuntimeTurnId,
  currentUserText,
  inboundAttachments,
  normalizeTurnPrompt,
  promptContextIncludesSection,
} from "./native-turn-prompt.ts";
import { createAuditedButlerToolExecutor } from "./native-audited-tool-executor.ts";
import type { RuntimeSemanticProgressSafetyNet } from "./native-audited-executor-types.ts";
import {
  emitRuntimePreparationProgressBestEffort,
  emitTurnEventBestEffort,
} from "./native-turn-delivery-events.ts";
import { appendRuntimeTurnContextMetric } from "../../operations/metrics/context-monitor.ts";
import { renderFeedbackBufferContext } from "../cognition/feedback/buffer.ts";
import {
  defaultRecentConversationTokenBudget,
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
import type { PublicWorkDecision, ToolAuditEntry } from "./native-tool-types.ts";
import {
  loadSessionContextPolicyCatalog,
  renderSessionContextPolicyContext,
} from "../policy/session-context-policy.ts";
import { workerModelRulesFromMetadata } from "./native-turn-metadata-policy.ts";
import { runtimePreparationProgressSummary } from "./native-runtime-preparation-progress.ts";
import type { NativeTurnRunnerDeps, NativeStoredSessionConfig } from "./native-turn-runner-types.ts";

export async function prepareNativeTurnContext(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
  pendingPublicDecisions: PublicWorkDecision[];
}) {
  const userText = currentUserText(input.turnInput);
  const plannedReview = plannedReviewTurnContext(input.turnInput);
  await maybeCompact(input);
  const recallContext = await maybeRecall(input, userText);
  const compactionContext = renderCompactionContext(readLatestCompactionSnapshot({
    butlerData: input.deps.butlerData,
    sessionId: input.turnInput.handle.sessionId,
  }));
  const turnId = currentRuntimeTurnId(input.turnInput) ?? `turn-${randomUUID().slice(0, 12)}`;
  const turnBudget = createDirectTurnBudget(turnId);
  const normalizedPrompt = normalizeTurnPrompt(input.turnInput, {
    recallContext,
    compactionContext,
    feedbackBufferContext: feedbackBufferContext(input, compactionContext),
    workingMemoryContext: workingMemoryContext(input),
    runtimePolicyContext: renderSessionContextPolicyContext({
      catalog: loadSessionContextPolicyCatalog(input.deps.butlerHome),
      session: input.session.init,
    }),
    recentConversationTokenBudget: recentConversationBudgetForTurn({
      configuredBudget: input.deps.recentConversationTokenBudget ??
        defaultRecentConversationTokenBudget(input.turnInput.model),
      compactionContext,
    }),
    butlerData: input.deps.butlerData,
  });
  const attachments = inboundAttachments(input.turnInput);
  const currentAttachmentContext = renderAttachmentContext(attachments, {
    butlerData: input.deps.butlerData,
    title: "Inbound Attachments",
    maxAttachmentTextChars: 18_000,
    maxTotalTextChars: 36_000,
  });
  const toolSurfaceController = new ToolSurfacePromptController({
    role: input.session.init.role,
    sessionMetadata: input.session.init.metadata,
    turnMetadata: input.turnInput.metadata,
    providerCapabilities: input.turnInput.provider.capabilities,
    tools: BUTLER_TOOLS,
    providerSupportsSchemaPromotion:
      input.turnInput.provider.capabilities.supportsSameTurnToolSchemaPromotion === true,
  });
  const semanticProgressSafetyNet = semanticProgressSafetyNetFor(input.deps.messageLanguage);
  const prompt = normalizedPrompt.prompt;
  const executor = createAuditedButlerToolExecutor({
    sessionId: input.turnInput.handle.sessionId,
    audit: input.audit,
    publicDecisionContext: input.publicDecisionContext,
    pendingPublicDecisions: input.pendingPublicDecisions,
    turnInput: input.turnInput,
    butlerData: input.deps.butlerData,
    messageLanguage: input.deps.messageLanguage,
    plannedReview,
    semanticProgressSafetyNet,
    toolSurfaceController,
    executor: input.deps.butlerToolExecutor ?? createButlerToolExecutor({
      butlerHome: input.deps.butlerHome,
      butlerData: input.deps.butlerData,
      appMessageDbPath: input.deps.appMessageDbPath,
      workspacePath: input.session.init.workspacePath,
      sessionId: input.turnInput.handle.sessionId,
      projectId: projectId(input.session),
      turnId: currentRuntimeTurnId(input.turnInput) ?? undefined,
      workerModel: input.turnInput.model,
      webSearchProvider: input.deps.webSearchProvider,
      searchPlannerModel: input.turnInput.model,
      searchPlannerOriginalRequest: userText,
      workerModelRules: workerModelRulesFromMetadata(
        input.turnInput.metadata?.workerModelRules ?? input.session.init.metadata?.workerModelRules,
      ),
      turnContext: [prompt, currentAttachmentContext].filter(Boolean).join("\n\n"),
      currentToolNames: () => toolSurfaceController.currentToolNames(),
      describedToolIds: () => toolSurfaceController.describedToolIdList(),
    }),
  });
  await emitStartedAndPreparation({
    ...input,
    turnId,
    turnBudget,
    normalizedPrompt,
    currentAttachmentContext,
  });
  recordContextMetric(input, normalizedPrompt, prompt);
  return {
    userText,
    plannedReview,
    turnId,
    turnBudget,
    prompt,
    normalizedPrompt,
    promptSections: promptUsageSectionsFromPrompt(normalizedPrompt),
    attachments,
    toolSurfaceController,
    executor,
    semanticProgressSafetyNet,
  };
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
  deps: NativeTurnRunnerDeps;
}): Promise<void> {
  try {
    await maybeAutoCompactSession({
      butlerData: input.deps.butlerData,
      sessionId: input.turnInput.handle.sessionId,
      modelRef: input.turnInput.model,
      budgetOverrides: input.deps.contextBudgetOverrides,
    });
  } catch {
    // Compaction is a safety optimization; it must not block the active turn.
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
  if (!input.deps.automaticRecallEnabled || !shouldAttemptAutomaticRecall(input.turnInput, userText)) {
    return "";
  }
  try {
    return renderRecallContext(await input.deps.runAutomaticRecall({
      butlerData: input.deps.butlerData,
      cue: userText,
      projectId: projectId(input.session),
      limit: 4,
    }));
  } catch {
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
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  turnId: string;
  turnBudget: ReturnType<typeof createDirectTurnBudget>;
  normalizedPrompt: ReturnType<typeof normalizeTurnPrompt>;
  currentAttachmentContext: string;
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
  await emitRuntimePreparationProgressBestEffort({
    turnInput: input.turnInput,
    progress: runtimePreparationProgressSummary({
      prompt: input.normalizedPrompt,
      attachmentContextChars: input.currentAttachmentContext.length,
      attachmentCount: inboundAttachments(input.turnInput).length,
      model: input.turnInput.model,
      language: input.deps.messageLanguage,
      useTools: input.useTools,
    }),
  });
}

function recordContextMetric(
  input: { turnInput: RuntimeTurnInput; deps: NativeTurnRunnerDeps },
  normalizedPrompt: ReturnType<typeof normalizeTurnPrompt>,
  prompt: string,
): void {
  try {
    appendRuntimeTurnContextMetric({
      butlerData: input.deps.butlerData,
      sessionId: input.turnInput.handle.sessionId,
      model: input.turnInput.model,
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
}

function projectId(session: NativeStoredSessionConfig): string | undefined {
  return typeof session.init.metadata?.projectId === "string"
    ? session.init.metadata.projectId
    : undefined;
}
