import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";
import type { RuntimeTurnResult } from "../../../../test-support/harness/contracts.ts";
import { runtimeArtifactsFromAudit } from "../output/runtime-artifacts.ts";
import { emitTurnEventBestEffort } from "../progress/turn-delivery-events.ts";
import {
  isPromptUsageModelCallBudgetError,
  recoverableLimitedDeliveryForError,
} from "../../recoverable-delivery.ts";
import { deliveredWithLimitationsState } from "../../runtime-delivery-state.ts";
import {
  clearTurnContextAtom,
  createTurnContextAtomId,
  isTurnSchedulerContinuationYieldError,
  persistTurnContextAtom,
  TurnSchedulerContinuationYieldError,
} from "../../turn-continuation-context.ts";
import { safeRuntimeFailure } from "../../../../integrations/providers/provider-errors.ts";
import {
  cancelActiveWorkStreamBestEffort,
  completeReportingWorkStreamBestEffort,
  completeRuntimeSemanticWorkStreamBestEffort,
  markActiveWorkStreamRecoverableBestEffort,
} from "./workstream-finalizers.ts";
import {
  emitInterruptedTurnOutcome,
  emitCompletionReviewTerminalOutcome,
  emitSuccessfulTurnOutcome,
} from "./turn-outcome-events.ts";
import {
  collectTurnContinuationRefs,
  persistCompletionGapContinuation,
  produceFinalDeliveryOutcome,
} from "./final-delivery-gates.ts";
import { prepareNativeTurnContext } from "./turn-context-builder.ts";
import { createNativeTurnPromptRunners } from "./turn-prompt-runners.ts";
import { runtimePreparationProgressSummary } from "./runtime-preparation-progress.ts";
import { emitRuntimePreparationProgressBestEffort } from "../progress/turn-delivery-events.ts";
import { throwIfRuntimeTurnAborted } from "../policy/turn-errors.ts";
import { unresolvedValidationFailureFromAudit } from "./validation-failure-guard.ts";
import type { PublicWorkDecision, ToolAuditEntry } from "../output/tool-types.ts";
import type { NativeTurnRunnerInput } from "./turn-runner-types.ts";
import { finalDeliveryBlockerForOpenDirectWork } from "../../direct-work-continuation.ts";

export async function runNativeToolTurn({
  input,
  session,
  deps,
  startedAt,
}: NativeTurnRunnerInput): Promise<RuntimeTurnResult> {
  throwIfRuntimeTurnAborted(input.signal);
  const useTools = ["butler", "steward", "worker"].includes(session.init.role);
  let turnId: string | undefined;
  try {
    const audit: ToolAuditEntry[] = [];
    const publicDecisionContext: PublicWorkDecision[] = [];
    const pendingPublicDecisions: PublicWorkDecision[] = [];
    let assistantTextBeforeToolsSeen = false;
    const earlyProgressEmitted = useTools
      ? await emitEarlyRuntimePreparationProgress({
          input,
          language: deps.messageLanguage,
        })
      : false;
    const context = await prepareNativeTurnContext({
      turnInput: input,
      session,
      deps,
      startedAt,
      useTools,
      audit,
      publicDecisionContext,
      pendingPublicDecisions,
      assistantTextBeforeToolsSeen: () => assistantTextBeforeToolsSeen,
      skipRuntimePreparationProgress: earlyProgressEmitted,
    });
    turnId = context.turnId;
    const { runToolPrompt, runTextPrompt } = createNativeTurnPromptRunners({
      turnInput: input,
      session,
      deps,
      turnId: context.turnId,
      turnBudget: context.turnBudget,
      promptSections: context.promptSections,
      attachments: context.attachments,
      executor: context.executor,
      toolSurfaceController: context.toolSurfaceController,
      plannedReview: context.plannedReview,
      publicDecisionContext,
      pendingPublicDecisions,
      markAssistantTextBeforeToolsSeen: () => {
        assistantTextBeforeToolsSeen = true;
      },
    });
    const runKernelToolPrompt = async (
      promptText: string,
      maxToolRounds?: number,
      phase?: string,
    ): Promise<string> => {
      try {
        return await runToolPrompt(promptText, maxToolRounds, phase);
      } catch (error) {
        if (!isPromptUsageModelCallBudgetError(error)) throw error;
        const contextAtomId = await persistSchedulerContinuation({
          input,
          deps,
          turnId: context.turnId,
          audit,
          publicDecisionContext,
          error,
        });
        throw new TurnSchedulerContinuationYieldError(
          input.handle.sessionId,
          context.turnId,
          contextAtomId,
        );
      }
    };
    let candidateText = useTools
      ? await runKernelToolPrompt(context.prompt, undefined, "initial_tool_loop")
      : await runTextPrompt(context.prompt);
    throwIfRuntimeTurnAborted(input.signal);
    let decisionCheckedText: string | null = null;
    while (true) {
      const deliveryOutcome = await produceFinalDeliveryOutcome({
        turnInput: input,
        session,
        deps,
        useTools,
        prompt: context.prompt,
        userText: context.userText,
        initialText: candidateText,
        audit,
        publicDecisionContext,
        toolSurfaceController: context.toolSurfaceController,
        runToolPrompt: runKernelToolPrompt,
        turnId,
        turnBudget: context.turnBudget,
      });
      if (deliveryOutcome.kind === "final") {
        decisionCheckedText = deliveryOutcome.text;
        break;
      }
      if (deliveryOutcome.kind === "waiting_user") {
        await emitCompletionReviewTerminalOutcome({
          turnInput: input,
          outcome: "waiting_user",
          publicSummary: deliveryOutcome.question,
          evidenceRefs: deliveryOutcome.evidenceRefs,
          turnId,
        });
        return {
          text: deliveryOutcome.question,
          runtimeSessionRef: input.handle.runtimeSessionRef,
          artifacts: runtimeArtifactsFromAudit({
            audit,
            butlerData: deps.butlerData,
            workspacePath: session.init.workspacePath,
          }),
        };
      }
      if (deliveryOutcome.kind === "failed") {
        await emitCompletionReviewTerminalOutcome({
          turnInput: input,
          outcome: "failed",
          publicSummary: deliveryOutcome.publicSummary,
          evidenceRefs: deliveryOutcome.evidenceRefs,
          turnId,
        });
        return {
          text: deliveryOutcome.publicSummary,
          runtimeSessionRef: input.handle.runtimeSessionRef,
          artifacts: runtimeArtifactsFromAudit({
            audit,
            butlerData: deps.butlerData,
            workspacePath: session.init.workspacePath,
          }),
        };
      }
      await persistCompletionGapContinuation({
        turnInput: input,
        deps,
        turnId,
        audit,
        publicDecisionContext,
        observation: deliveryOutcome.observation,
      });
      candidateText = await runKernelToolPrompt(completionGapContinuationPrompt({
        observationSummary: deliveryOutcome.observation.summary,
        modelVisibleContent: deliveryOutcome.observation.modelVisibleContent,
      }), undefined, "completion_gap_continuation");
      throwIfRuntimeTurnAborted(input.signal);
    }
    if (decisionCheckedText === null) {
      throw new Error("completion delivery exited without terminal outcome");
    }
    const directWorkBlocker = session.init.role === "butler"
      ? finalDeliveryBlockerForOpenDirectWork({
        butlerData: deps.butlerData,
        sessionId: input.handle.sessionId,
        turnId,
      })
      : null;
    if (directWorkBlocker) {
      const publicSummary = directWorkBlocker.activeItems.at(0)
        ? `Direct work remains incomplete: ${directWorkBlocker.activeItems.at(0)?.label}`
        : "Direct work remains incomplete.";
      await emitCompletionReviewTerminalOutcome({
        turnInput: input,
        outcome: "failed",
        publicSummary,
        evidenceRefs: [
          `work_stream:${directWorkBlocker.id}`,
          ...(directWorkBlocker.listId ? [`todo_list:${directWorkBlocker.listId}`] : []),
        ],
        turnId,
      });
      return {
        text: publicSummary,
        runtimeSessionRef: input.handle.runtimeSessionRef,
        artifacts: runtimeArtifactsFromAudit({
          audit,
          butlerData: deps.butlerData,
          workspacePath: session.init.workspacePath,
        }),
      };
    }
    if (turnId) {
      clearTurnContextAtom({
        butlerData: deps.butlerData,
        sessionId: input.handle.sessionId,
        turnId,
      });
    }
    if (useTools) {
      completeRuntimeSemanticWorkStreamBestEffort({
        butlerData: deps.butlerData,
        sessionId: input.handle.sessionId,
        projectId: projectId(session),
        tracker: context.semanticProgressSafetyNet,
        language: deps.messageLanguage,
        audit,
      });
      completeReportingWorkStreamBestEffort({
        butlerData: deps.butlerData,
        sessionId: input.handle.sessionId,
        turnId,
        audit,
      });
    }
    const delivery = deliveryForFinalAudit(audit);
    await emitFinalEvents(input, decisionCheckedText, audit, delivery, turnId);
    recordTurnMetric({
      status: "ok",
      input,
      session,
      deps,
      startedAt,
      useTools,
      audit,
      publicDecisionContext,
      promptChars: context.prompt.length,
      recallContextChars: context.normalizedPrompt.recallContextChars,
      compactionContextChars: context.normalizedPrompt.compactionContextChars,
      workingMemoryContextChars: context.normalizedPrompt.workingMemoryContextChars,
    });
    return {
      text: decisionCheckedText,
      runtimeSessionRef: input.handle.runtimeSessionRef,
      delivery,
      artifacts: runtimeArtifactsFromAudit({
        audit,
        butlerData: deps.butlerData,
        workspacePath: session.init.workspacePath,
      }),
    };
  } catch (error) {
    const limitedDelivery = recoverableLimitedDeliveryForError(error);
    const isBudgetError = isPromptUsageModelCallBudgetError(error);
    const isSchedulerYield = isTurnSchedulerContinuationYieldError(error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (isBudgetError && turnId) {
      const safeFailure = safeRuntimeFailure(error);
      persistTurnContextAtom({
        butlerData: deps.butlerData,
        sessionId: input.handle.sessionId,
        turnId,
        state: "continuing",
        sourceErrorCode: safeFailure.code,
        reason: safeFailure.message,
        unresolvedObservations: [],
      });
    }
    if (useTools) {
      if (input.signal?.aborted) {
        cancelActiveWorkStreamBestEffort({
          butlerData: deps.butlerData,
          sessionId: input.handle.sessionId,
          turnId,
        });
      } else if (!limitedDelivery && !isBudgetError && !isSchedulerYield) {
        markActiveWorkStreamRecoverableBestEffort({
          butlerData: deps.butlerData,
          sessionId: input.handle.sessionId,
          turnId,
          reason: errorMessage,
        });
      }
    }
    if (!limitedDelivery && !isBudgetError && !isSchedulerYield) {
      await emitInterruptedTurnOutcome({
        turnInput: input,
        cancelled: Boolean(input.signal?.aborted),
        reason: errorMessage,
      });
      await emitTurnEventBestEffort(input, {
        kind: input.signal?.aborted ? "turn.cancelled" : "turn.failed",
        payload: { safeLabel: input.signal?.aborted ? "Cancelled" : "Failed" },
      });
    }
    recordTurnMetric({
      status: "error",
      input,
      session,
      deps,
      startedAt,
      useTools,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}

async function persistSchedulerContinuation(input: {
  input: NativeTurnRunnerInput["input"];
  deps: NativeTurnRunnerInput["deps"];
  turnId: string;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
  error: unknown;
}): Promise<string> {
  const safeFailure = safeRuntimeFailure(input.error);
  const contextAtomId = createTurnContextAtomId(input.input.handle.sessionId, input.turnId);
  const refs = collectTurnContinuationRefs({
    butlerData: input.deps.butlerData,
    sessionId: input.input.handle.sessionId,
    turnId: input.turnId,
    audit: input.audit,
    publicDecisionContext: input.publicDecisionContext,
  });
  persistTurnContextAtom({
    butlerData: input.deps.butlerData,
    sessionId: input.input.handle.sessionId,
    turnId: input.turnId,
    state: "continuing",
    sourceErrorCode: safeFailure.code,
    reason: "Scheduler yielded before the next model request.",
    userRequest: {
      id: currentUserMessageRef(input.input),
    },
    ...refs,
    unresolvedObservations: [{
      kind: "context_compacted",
      id: `context-atom:${contextAtomId}`,
    }],
  });
  await emitTurnEventBestEffort(input.input, {
    kind: "turn.observation",
    visibility: "internal",
    payload: {
      kind: "context_compacted",
      visibility: "operator",
      safeLabel: "Continuation context atom persisted.",
      refs: [{
        kind: "context_atom",
        id: contextAtomId,
      }],
    },
  });
  await emitTurnEventBestEffort(input.input, {
    kind: "turn.continuation_scheduled",
    visibility: "internal",
    payload: {
      reason: safeFailure.code,
      safeLabel: "Continuation scheduled.",
      refs: [{
        kind: "context_atom",
        id: contextAtomId,
      }],
    },
  });
  return contextAtomId;
}

function completionGapContinuationPrompt(input: {
  observationSummary: string;
  modelVisibleContent: string;
}): string {
  return [
    "Completion review produced a model-visible observation for this same logical turn.",
    "Do not deliver final text yet. Continue the current work from the observation.",
    `Observation: ${input.observationSummary}`,
    input.modelVisibleContent,
  ].filter(Boolean).join("\n\n");
}


async function emitEarlyRuntimePreparationProgress(input: {
  input: NativeTurnRunnerInput["input"];
  language: NativeTurnRunnerInput["deps"]["messageLanguage"];
}): Promise<boolean> {
  try {
    await emitRuntimePreparationProgressBestEffort({
      turnInput: input.input,
      progress: runtimePreparationProgressSummary({
        model: input.input.model,
        language: input.language,
        useTools: true,
        userText: currentUserText(input.input),
      }),
    });
    return true;
  } catch {
    return false;
  }
}

function deliveryForFinalAudit(audit: ToolAuditEntry[]): RuntimeTurnResult["delivery"] {
  const validationFailure = unresolvedValidationFailureFromAudit(audit);
  if (!validationFailure) return undefined;
  const limitation = `Validation suite failed without a later passing receipt: ${validationFailure.suite}`;
  return deliveredWithLimitationsState({
    limitationCodes: ["validation_failed"],
    limitations: [limitation],
  });
}

async function emitFinalEvents(
  input: NativeTurnRunnerInput["input"],
  text: string,
  audit: ToolAuditEntry[],
  delivery?: RuntimeTurnResult["delivery"],
  turnId?: string,
): Promise<void> {
  const limitedDelivery = delivery?.delivery_state === "delivered_with_limitations";
  await emitSuccessfulTurnOutcome({
    turnInput: input,
    audit,
    limitedDelivery,
    turnId,
  });
  await emitTurnEventBestEffort(input, {
    kind: "message.final.started",
    payload: { safeLabel: "Preparing final answer" },
  });
  await emitTurnEventBestEffort(input, {
    kind: "message.final.completed",
    payload: {
      safeLabel: limitedDelivery ? "Final answer ready with limitations" : "Final answer ready",
      textChars: text.length,
      ...(delivery ?? {}),
    },
  });
  await emitTurnEventBestEffort(input, {
    kind: "turn.completed",
    payload: {
      safeLabel: limitedDelivery ? "Completed with limitations" : "Completed",
      ...(delivery ?? {}),
    },
  });
}

function recordTurnMetric(input: {
  status: "ok" | "error";
  input: NativeTurnRunnerInput["input"];
  session: NativeTurnRunnerInput["session"];
  deps: NativeTurnRunnerInput["deps"];
  startedAt: number;
  useTools: boolean;
  audit?: ToolAuditEntry[];
  publicDecisionContext?: PublicWorkDecision[];
  promptChars?: number;
  recallContextChars?: number;
  compactionContextChars?: number;
  workingMemoryContextChars?: number;
  errorName?: string;
}): void {
  recordOperationalMetric({
    category: "runtime",
    name: "turn",
    status: input.status,
    durationMs: Date.now() - input.startedAt,
    dimensions: {
      role: input.session.init.role,
      runtime: input.deps.runtimeId,
      model: input.input.model,
      ...(input.status === "error" ? { errorName: input.errorName ?? "UnknownError" } : {
        useTools: input.useTools,
        toolCalls: input.audit?.length ?? 0,
        publicDecisions: input.publicDecisionContext?.length ?? 0,
        publicDecisionAssistantAuthored:
          input.publicDecisionContext?.filter((decision) => decision.source === "assistant-authored").length ?? 0,
        publicDecisionRuntimeDerived:
          input.publicDecisionContext?.filter((decision) => decision.source === "runtime-derived").length ?? 0,
        recallContextChars: input.recallContextChars ?? 0,
        compactionContextChars: input.compactionContextChars ?? 0,
        workingMemoryContextChars: input.workingMemoryContextChars ?? 0,
        promptChars: input.promptChars ?? 0,
      }),
    },
  }, { butlerData: input.deps.butlerData });
}

function projectId(session: NativeTurnRunnerInput["session"]): string | undefined {
  return typeof session.init.metadata?.projectId === "string"
    ? session.init.metadata.projectId
    : undefined;
}

function currentUserText(input: NativeTurnRunnerInput["input"]): string {
  if ("eventId" in input.input) return input.input.message.text ?? "";
  return input.input.text ?? "";
}

function currentUserMessageRef(input: NativeTurnRunnerInput["input"]): string {
  if ("eventId" in input.input && typeof input.input.message.id === "string") {
    return input.input.message.id;
  }
  return `turn:${input.handle.sessionId}`;
}
