import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";
import { recordFirstVisibleLatencyMetric } from "../../../../operations/metrics/first-visible-latency.ts";
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
import { snapshotDirectTurnBudget, type DirectTurnBudget } from "../../direct-turn-budget.ts";
import { safeRuntimeFailure } from "../../../../integrations/providers/provider-errors.ts";
import {
  cancelActiveWorkStreamBestEffort,
  completeReportingWorkStreamBestEffort,
  completeRuntimeSemanticWorkStreamBestEffort,
  markActiveWorkStreamRecoverableBestEffort,
} from "./workstream-finalizers.ts";
import {
  emitInterruptedTurnOutcome,
  emitSuccessfulTurnOutcome,
} from "./turn-outcome-events.ts";
import {
  collectTurnContinuationRefs,
  persistCompletionGapContinuation,
  produceFinalDeliveryOutcome,
} from "./final-delivery-gates.ts";
import {
  applyPublicOutputGuards,
  repairFinalContract,
} from "./public-output-gates.ts";
import { prepareNativeTurnContext } from "./turn-context-builder.ts";
import { createNativeTurnPromptRunners } from "./turn-prompt-runners.ts";
import { runtimePreparationProgressSummary } from "./runtime-preparation-progress.ts";
import { emitRuntimePreparationProgressBestEffort } from "../progress/turn-delivery-events.ts";
import { throwIfRuntimeTurnAborted } from "../policy/turn-errors.ts";
import { unresolvedValidationFailureFromAudit } from "./validation-failure-guard.ts";
import type { PublicWorkDecision, ToolAuditEntry } from "../output/tool-types.ts";
import type { NativeTurnRunnerInput } from "./turn-runner-types.ts";
import {
  createTurnKernelController,
  type TurnKernelController,
} from "../../turn-kernel.ts";
import { closeDirectWork } from "./direct-work-finalizer.ts";
import { installTurnLatencyTracker } from "../metrics/turn-latency-tracker.ts";
import {
  completionGapFingerprint,
  createWorkStreamPhaseBudgetController,
  promptUsageModelCallBudgetExhaustedError,
} from "../../workstream-phase-budget.ts";
import {
  commitTurnContractContinuation,
  completeTurnContractDelivery,
  resumeTurnContractExecution,
  type ActiveTurnContract,
} from "./turn-contract-runtime.ts";
import { runTypedTurnEntry } from "./typed-turn-entry.ts";
import {
  recordTurnResourceMetrics,
  turnResourceSnapshot,
  type TurnResourceSnapshot,
} from "./turn-resource-metrics.ts";

export async function runNativeToolTurn({
  input,
  session,
  deps,
  startedAt,
}: NativeTurnRunnerInput): Promise<RuntimeTurnResult> {
  throwIfRuntimeTurnAborted(input.signal);
  const resourcesAtStart = turnResourceSnapshot();
  const useTools = ["butler", "steward", "worker"].includes(session.init.role);
  let turnId: string | undefined;
  let toolLoopUsed = false;
  const turnKernel = createTurnKernelController("accepted");
  try {
    const audit: ToolAuditEntry[] = [];
    const publicDecisionContext: PublicWorkDecision[] = [];
    const pendingPublicDecisions: PublicWorkDecision[] = [];
    let assistantTextBeforeToolsSeen = false;
    let finalDeliveryOverride: RuntimeTurnResult["delivery"] | undefined;
    const gatewayProgressEmitted = gatewayFirstVisibleProgressEmitted(input.metadata);
    const earlyProgressEmitted = useTools && !gatewayProgressEmitted
      ? await emitEarlyRuntimePreparationProgress({
        input,
        deps,
        session,
        startedAt,
      })
      : gatewayProgressEmitted;
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
    const latencyTracker = installTurnLatencyTracker({
      turnInput: input,
      butlerData: deps.butlerData,
      startedAt,
      role: session.init.role,
      runtime: deps.runtimeId,
      model: input.model,
    });
    const phaseBudgetController = createWorkStreamPhaseBudgetController({
      butlerData: deps.butlerData,
      resumeSelection: context.resumeSelection,
      role: session.init.role,
      runtime: deps.runtimeId,
      model: input.model,
    });
    const turnContractContext: { current: ActiveTurnContract | null } = { current: null };
    turnKernel.transitionTo("model_deciding");
    const { runToolPrompt, runTextPrompt, runPrivateTextPrompt } = createNativeTurnPromptRunners({
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
      latencyTracker,
      phaseBudgetController,
      turnContractContext,
    });
    const runKernelToolPrompt = async (
      promptText: string,
      maxToolRounds?: number,
      phase?: string,
    ): Promise<string> => {
      toolLoopUsed = true;
      try {
        return await runToolPrompt(promptText, maxToolRounds, phase);
      } catch (error) {
        if (!isPromptUsageModelCallBudgetError(error)) throw error;
        const contextAtomId = await persistSchedulerContinuation({
          input,
          deps,
          turnId: context.turnId,
          turnBudget: context.turnBudget,
          audit,
          publicDecisionContext,
          ...(turnContractContext.current
            ? { contractId: turnContractContext.current.contract.contract_id }
            : {}),
          error,
        });
        throw new TurnSchedulerContinuationYieldError(
          input.handle.sessionId,
          context.turnId,
          contextAtomId,
        );
      }
    };
    const completionGapFingerprints = new Set<string>();
    const initialPromptPhase = phaseBudgetController?.initialPromptPhase() ?? "initial_tool_loop";
    let candidateText: string;
    let activeTurnContract: ActiveTurnContract | null = null;
    if (useTools && session.init.role === "butler" && input.provider.capabilities.supportsStructuredOutputs === true) {
      const typedEntry = await runTypedTurnEntry({
        turnInput: input,
        session,
        butlerData: deps.butlerData,
        projectId: projectId(session),
        context,
        initialPromptPhase,
        pendingPublicDecisions,
        turnContractContext,
        runPrivateTextPrompt,
        runKernelToolPrompt,
      });
      candidateText = typedEntry.candidateText;
      activeTurnContract = typedEntry.activeTurnContract;
    } else if (useTools && input.provider.capabilities.supportsStructuredOutputs === false) {
      throw new Error("provider_capability_missing");
    } else {
      candidateText = useTools
        ? await runKernelToolPrompt(context.prompt, undefined, initialPromptPhase)
        : await runTextPrompt(context.prompt);
    }
    throwIfRuntimeTurnAborted(input.signal);
    turnKernel.transitionTo("observing_tools");
    let decisionCheckedText: string | null = null;
    while (true) {
      const deliveryOutcome = await produceFinalDeliveryOutcome({
        turnInput: input,
        session,
        deps,
        useTools: toolLoopUsed,
        prompt: context.prompt,
        userText: context.userText,
        initialText: candidateText,
        audit,
        publicDecisionContext,
        toolSurfaceController: context.toolSurfaceController,
        turnContract: activeTurnContract?.contract,
        turnId,
        turnBudget: context.turnBudget,
      });
      if (deliveryOutcome.kind === "final") {
        const directWorkResult = await closeDirectWork({
          turnInput: input,
          deps,
          useTools: toolLoopUsed && session.init.role === "butler",
          turnId,
          turnBudget: context.turnBudget,
          userText: context.userText,
          finalText: deliveryOutcome.text,
          audit,
          runToolPrompt: runKernelToolPrompt,
          guardFinalText: async (finalText) => {
            const contractRepairedText = repairFinalContract({
              turnInput: input,
              session,
              deps,
              useTools: toolLoopUsed,
              prompt: context.prompt,
              finalText,
              audit,
              publicDecisionContext,
            });
            await emitTurnEventBestEffort(input, {
              kind: "guard.started",
              payload: { guard: "public_output" },
            });
            const guardedText = applyPublicOutputGuards({
              turnInput: input,
              session,
              deps,
              useTools: toolLoopUsed,
              userText: context.userText,
              finalText: contractRepairedText,
              audit,
            });
            await emitTurnEventBestEffort(input, {
              kind: "guard.completed",
              payload: { guard: "public_output", status: "approved" },
            });
            return guardedText;
          },
        });
        decisionCheckedText = directWorkResult.text;
        finalDeliveryOverride = directWorkResult.delivery;
        break;
      }
      const gapPhase = phaseBudgetController?.completionGapPhase() ?? "completion_gap_continuation";
      const gapFingerprint = completionGapFingerprint(deliveryOutcome.observation);
      const repeatedGap = phaseBudgetController !== null && completionGapFingerprints.has(gapFingerprint);
      completionGapFingerprints.add(gapFingerprint);
      await persistCompletionGapContinuation({
        turnInput: input,
        deps,
        turnId,
        audit,
        publicDecisionContext,
        ...(activeTurnContract ? { contractId: activeTurnContract.contract.contract_id } : {}),
        observation: deliveryOutcome.observation,
      });
      if (repeatedGap) {
        phaseBudgetController.recordPhaseBudgetExhausted({
          phase: gapPhase,
          reason: "repeated_completion_gap",
        });
        const contextAtomId = await persistSchedulerContinuation({
          input,
          deps,
          turnId: context.turnId,
          turnBudget: context.turnBudget,
          audit,
          publicDecisionContext,
          ...(activeTurnContract ? { contractId: activeTurnContract.contract.contract_id } : {}),
          error: promptUsageModelCallBudgetExhaustedError(),
        });
        throw new TurnSchedulerContinuationYieldError(
          input.handle.sessionId,
          context.turnId,
          contextAtomId,
        );
      }
      if (activeTurnContract) {
        activeTurnContract.contract = resumeTurnContractExecution({
          butlerData: deps.butlerData,
          active: activeTurnContract,
        });
      }
      candidateText = await runKernelToolPrompt(completionGapContinuationPrompt({
        observationSummary: deliveryOutcome.observation.summary,
        modelVisibleContent: deliveryOutcome.observation.modelVisibleContent,
      }), undefined, gapPhase);
      throwIfRuntimeTurnAborted(input.signal);
      turnKernel.transitionTo("continuing");
      turnKernel.transitionTo("model_deciding");
      turnKernel.transitionTo("observing_tools");
    }
    if (decisionCheckedText === null) {
      throw new Error("completion delivery exited without terminal outcome");
    }
    if (activeTurnContract) {
      activeTurnContract.contract = completeTurnContractDelivery({
        butlerData: deps.butlerData,
        active: activeTurnContract,
      });
    }
    if (turnId) {
      clearTurnContextAtom({
        butlerData: deps.butlerData,
        sessionId: input.handle.sessionId,
        turnId,
      });
    }
    if (toolLoopUsed) {
      completeRuntimeSemanticWorkStreamBestEffort({
        butlerData: deps.butlerData,
        sessionId: input.handle.sessionId,
        originChatId: context.chatId,
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
    const delivery = mergedFinalDelivery(finalDeliveryOverride, deliveryForFinalAudit(audit));
    await emitFinalEvents(input, decisionCheckedText, audit, turnKernel, delivery, turnId);
    recordTurnMetric({
      status: "ok",
      input,
      session,
      deps,
      startedAt,
      useTools: toolLoopUsed,
      resourcesAtStart,
      audit,
      publicDecisionContext,
      promptChars: context.prompt.length,
      recallContextChars: context.normalizedPrompt.recallContextChars,
      compactionContextChars: context.normalizedPrompt.compactionContextChars,
      workingMemoryContextChars: context.normalizedPrompt.workingMemoryContextChars,
      resumeSelectionState: context.resumeSelection.state,
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
    const isCompletionIncomplete = error instanceof Error && error.name === "GoalCompletionIncompleteError";
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
    if (toolLoopUsed) {
      if (input.signal?.aborted) {
        cancelActiveWorkStreamBestEffort({
          butlerData: deps.butlerData,
          sessionId: input.handle.sessionId,
          turnId,
        });
      } else if (!limitedDelivery && !isBudgetError && !isSchedulerYield && !isCompletionIncomplete) {
        markActiveWorkStreamRecoverableBestEffort({
          butlerData: deps.butlerData,
          sessionId: input.handle.sessionId,
          turnId,
          reason: errorMessage,
        });
      }
    }
    if (!limitedDelivery && !isBudgetError && !isSchedulerYield && !isCompletionIncomplete) {
      await emitInterruptedTurnOutcome({
        turnInput: input,
        cancelled: Boolean(input.signal?.aborted),
        reason: errorMessage,
        turnKernel,
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
      useTools: toolLoopUsed,
      resourcesAtStart,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}

async function persistSchedulerContinuation(input: {
  input: NativeTurnRunnerInput["input"];
  deps: NativeTurnRunnerInput["deps"];
  turnId: string;
  turnBudget: DirectTurnBudget;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
  contractId?: string;
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
  const persistedContextAtomId = persistTurnContextAtom({
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
    budgetSnapshot: snapshotDirectTurnBudget(input.turnBudget),
    unresolvedObservations: [{
      kind: "context_compacted",
      id: `context-atom:${contextAtomId}`,
    }],
  });
  if (!persistedContextAtomId) throw new Error("turn_continuation_commit_missing");
  if (input.contractId) {
    commitTurnContractContinuation({
      butlerData: input.deps.butlerData,
      contractId: input.contractId,
      commitId: persistedContextAtomId,
    });
  }
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
    "The Turn Kernel recorded a model-visible observation for this same logical turn.",
    "Do not deliver final text yet. Continue the current work from the observation.",
    `Observation: ${input.observationSummary}`,
    input.modelVisibleContent,
  ].filter(Boolean).join("\n\n");
}


async function emitEarlyRuntimePreparationProgress(input: {
  input: NativeTurnRunnerInput["input"];
  deps: NativeTurnRunnerInput["deps"];
  session: NativeTurnRunnerInput["session"];
  startedAt: number;
}): Promise<boolean> {
  try {
    await emitRuntimePreparationProgressBestEffort({
      turnInput: input.input,
      progress: runtimePreparationProgressSummary({
        model: input.input.model,
        language: input.deps.messageLanguage,
        useTools: true,
        userText: currentUserText(input.input),
      }),
      emitPreparationWorkBlock: true,
    });
    recordFirstVisibleLatencyMetric({
      butlerData: input.deps.butlerData,
      durationMs: Date.now() - input.startedAt,
      signal: "runtime_preparation",
      role: input.session.init.role,
      runtime: input.deps.runtimeId,
      model: input.input.model,
      source: "native-turn-runner-early-runtime-preparation",
    });
    return true;
  } catch {
    return false;
  }
}

function gatewayFirstVisibleProgressEmitted(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.gatewayFirstVisibleProgressEmitted === true;
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

function mergedFinalDelivery(
  primary: RuntimeTurnResult["delivery"] | undefined,
  secondary: RuntimeTurnResult["delivery"] | undefined,
): RuntimeTurnResult["delivery"] | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return {
    ...primary,
    limitation_codes: uniqueOrdered([
      ...primary.limitation_codes,
      ...secondary.limitation_codes,
    ]),
    limitations: uniqueOrdered([
      ...primary.limitations,
      ...secondary.limitations,
    ]),
  };
}

function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

async function emitFinalEvents(
  input: NativeTurnRunnerInput["input"],
  text: string,
  audit: ToolAuditEntry[],
  turnKernel: TurnKernelController,
  delivery?: RuntimeTurnResult["delivery"],
  turnId?: string,
): Promise<void> {
  const limitedDelivery = isLimitedFinalDelivery(delivery);
  await emitSuccessfulTurnOutcome({
    turnInput: input,
    audit,
    limitedDelivery,
    turnKernel,
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

function isLimitedFinalDelivery(
  delivery: RuntimeTurnResult["delivery"] | undefined,
): boolean {
  return delivery?.delivery_state === "delivered_with_limitations" ||
    delivery?.delivery_state === "delivered_with_continuation";
}

function recordTurnMetric(input: {
  status: "ok" | "error";
  input: NativeTurnRunnerInput["input"];
  session: NativeTurnRunnerInput["session"];
  deps: NativeTurnRunnerInput["deps"];
  startedAt: number;
  useTools: boolean;
  resourcesAtStart: TurnResourceSnapshot;
  audit?: ToolAuditEntry[];
  publicDecisionContext?: PublicWorkDecision[];
  promptChars?: number;
  recallContextChars?: number;
  compactionContextChars?: number;
  workingMemoryContextChars?: number;
  resumeSelectionState?: string;
  errorName?: string;
}): void {
  const durationMs = Date.now() - input.startedAt;
  recordOperationalMetric({
    category: "runtime",
    name: "turn",
    status: input.status,
    durationMs,
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
        resumeSelectionState: input.resumeSelectionState,
      }),
    },
  }, { butlerData: input.deps.butlerData });
  recordTurnResourceMetrics({
    butlerData: input.deps.butlerData,
    status: input.status,
    role: input.session.init.role,
    runtime: input.deps.runtimeId,
    model: input.input.model,
    durationMs,
    start: input.resourcesAtStart,
  });
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
