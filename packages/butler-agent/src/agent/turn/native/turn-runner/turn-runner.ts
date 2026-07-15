import { createHash } from "node:crypto";
import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";
import { recordFirstVisibleLatencyMetric } from "../../../../operations/metrics/first-visible-latency.ts";
import type { RuntimeTurnResult } from "../../../../test-support/harness/contracts.ts";
import { runtimeArtifactsFromAudit } from "../output/runtime-artifacts.ts";
import { emitTurnEventBestEffort } from "../progress/turn-delivery-events.ts";
import {
  isPromptUsageModelCallBudgetError,
} from "../../recoverable-delivery.ts";
import { deliveredWithLimitationsState } from "../../runtime-delivery-state.ts";
import {
  clearTurnContextAtom,
  createTurnContextAtomId,
  persistTurnContextAtom,
  readTurnContextAtom,
  TurnSchedulerContinuationYieldError,
} from "../../turn-continuation-context.ts";
import {
  canRolloverDirectTurnBudget,
  snapshotDirectTurnBudget,
  snapshotDirectTurnBudgetForRollover,
  type DirectTurnBudget,
} from "../../direct-turn-budget.ts";
import { principalTurnCancellationRecorded } from "../../principal-turn-cancellation-registry.ts";
import { safeRuntimeFailure } from "../../../../integrations/providers/provider-errors.ts";
import {
  cancelActiveWorkStreamBestEffort,
  completeReportingWorkStreamBestEffort,
  completeRuntimeSemanticWorkStreamBestEffort,
} from "./workstream-finalizers.ts";
import {
  emitInterruptedTurnOutcome,
  emitSuccessfulTurnOutcome,
} from "./turn-outcome-events.ts";
import {
  collectTurnContinuationRefs,
  produceFinalDeliveryOutcome,
} from "./final-delivery-gates.ts";
import {
  applyPublicOutputGuards,
  repairFinalContract,
} from "./public-output-gates.ts";
import { prepareNativeTurnContext } from "./turn-context-builder.ts";
import {
  createNativeTurnPromptRunners,
  type BtccToolPromptOptions,
} from "./turn-prompt-runners.ts";
import { runtimePreparationProgressSummary } from "./runtime-preparation-progress.ts";
import { readCurrentFinalCandidate } from "./final-candidate-review-store.ts";
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
  createWorkStreamPhaseBudgetController,
} from "../../workstream-phase-budget.ts";
import {
  commitTurnContractContinuation,
  completeTurnContractDelivery,
  restoreTurnContractExecution,
  resumeTurnContractExecution,
  type ActiveTurnContract,
} from "./turn-contract-runtime.ts";
import { runTypedTurnEntry } from "./typed-turn-entry.ts";
import {
  recordTurnResourceMetrics,
  turnResourceSnapshot,
  type TurnResourceSnapshot,
} from "./turn-resource-metrics.ts";
import { buildTurnContinuationEvidence } from "./turn-continuation-evidence.ts";
import {
  completionGapContinuationPrompt,
  completionGapFinalSynthesisPrompt,
} from "./turn-continuation-prompts.ts";
import { buildDurableTurnRoundJournal } from "./turn-round-journal.ts";
import { WorkStreamStore } from "../../../work/work-stream.ts";
import {
  recordTurnContractAuditEvidence,
  recordTurnContractBtccPhaseEvidence,
} from "./turn-contract-audit-evidence.ts";
import type { ObligationToolSurfaceState } from "./obligation-tool-surface.ts";
import { reviewProviderFinalCandidateInTurn } from "./provider-final-candidate-review.ts";
import {
  prepareBtccTurn,
  type PreparedBtccTurn,
} from "../../btcc/conception-runtime.ts";
import { BtccNativePhaseCoordinator } from "../../btcc/native-phase-coordinator.ts";
import { runBtccIndependentReview } from "../../btcc/independent-review.ts";
import {
  runBtccConsolidation,
  runBtccReporter,
  runBtccReportGuard,
  type BtccReportGuardGap,
} from "../../btcc/terminal-phases.ts";
import { runBtccPlanningSynthesis } from "../../btcc/planning-synthesis.ts";

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
  let preparedBtccTurn: PreparedBtccTurn | null = null;
  const turnKernel = createTurnKernelController("accepted");
  try {
    const audit: ToolAuditEntry[] = [];
    const publicDecisionContext: PublicWorkDecision[] = [];
    const pendingPublicDecisions: PublicWorkDecision[] = [];
    const turnContractContext: { current: ActiveTurnContract | null } = { current: null };
    let assistantTextBeforeToolsSeen = false;
    let finalDeliveryOverride: RuntimeTurnResult["delivery"] | undefined;
    const gatewayProgressEmitted = gatewayFirstVisibleProgressEmitted(input.metadata);
    const continuationProgressAlreadyExists = hasSchedulerContinuationMetadata(input.metadata);
    const earlyProgressEmitted = continuationProgressAlreadyExists || gatewayProgressEmitted || (useTools
      ? await emitEarlyRuntimePreparationProgress({
        input,
        deps,
        session,
        startedAt,
      })
      : false);
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
      activeWorkStreamBinding: () => activeWorkStreamBinding(turnContractContext.current),
      skipRuntimePreparationProgress: earlyProgressEmitted,
    });
    turnId = context.turnId;
    await emitCommittedContinuationScheduledEvent({
      turnInput: input,
      continuationAtom: context.continuationAtom,
    });
    const latencyTracker = installTurnLatencyTracker({
      turnInput: input,
      butlerData: deps.butlerData,
      startedAt,
      role: session.init.role,
      runtime: deps.runtimeId,
      model: input.model,
    });
    const phaseBudgetController = isSchedulerContinuation(input, context.continuationAtom)
      ? null
      : createWorkStreamPhaseBudgetController({
        butlerData: deps.butlerData,
        resumeSelection: context.resumeSelection,
        role: session.init.role,
        runtime: deps.runtimeId,
        model: input.model,
      });
    preparedBtccTurn = session.init.role === "butler"
      ? prepareBtccTurn({
        turnInput: input,
        butlerData: deps.butlerData,
        turnId: context.turnId,
        userText: context.userText,
        projectId: projectId(session),
        workspacePath: session.init.workspacePath,
        conversationContextPlan: context.conversationContextPlan,
        promptSectionIds: context.promptSections.map((section) => section.id),
        capabilityManifest: session.init.tools ?? [],
      })
      : null;
    turnKernel.transitionTo("model_deciding");
    const {
      obligationToolSurfaceState,
      nextSemanticBlockSequence,
      runToolPrompt,
      runTextPrompt,
      runPrivateTextPrompt,
      runPrivateFunctionDecisionPrompt,
    } = createNativeTurnPromptRunners({
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
      initialProviderRoundIndex: Math.max(
        0,
        (context.continuationAtom?.nextSemanticBlockSequence ?? 1) - 1,
      ),
      initialSemanticBlockSequence: context.continuationAtom?.nextSemanticBlockSequence ?? 0,
      initialObligationFrontier: context.continuationAtom?.obligationFrontier,
      reviewFinalCandidate: async ({ text }) => await reviewProviderFinalCandidateInTurn({
        candidateText: text,
        turnInput: input,
        session,
        deps,
        useTools: toolLoopUsed,
        turnId: context.turnId,
        turnBudget: context.turnBudget,
        prompt: context.prompt,
        userText: context.userText,
        audit,
        publicDecisionContext,
        toolSurfaceController: context.toolSurfaceController,
        activeTurnContract: turnContractContext.current,
      }),
    });
    const runKernelToolPrompt = async (
      promptText: string,
      maxToolRounds?: number,
      phase?: string,
      options?: BtccToolPromptOptions,
    ): Promise<string> => {
      toolLoopUsed = true;
      try {
        return await runToolPrompt(promptText, maxToolRounds, phase, options);
      } catch (error) {
        if (!isPromptUsageModelCallBudgetError(error) && !isRetryableProviderFailure(error)) {
          throw error;
        }
        if (
          isPromptUsageModelCallBudgetError(error) &&
          !canRolloverDirectTurnBudget(context.turnBudget, error)
        ) {
          throw error;
        }
        const checkpoint = await persistSchedulerContinuation({
          input,
          deps,
          turnId: context.turnId,
          turnBudget: context.turnBudget,
          audit,
          publicDecisionContext,
          activeTurnContract: turnContractContext.current,
          expectedGeneration: context.continuationAtom?.generation,
          nextSemanticBlockSequenceFloor: nextSemanticBlockSequence(),
          error,
          obligationFrontier: obligationToolSurfaceState(),
        });
        throw new TurnSchedulerContinuationYieldError(
          input.handle.sessionId,
          context.turnId,
          checkpoint.contextAtomId,
          checkpoint.checkpointId,
          checkpoint.generation,
          checkpoint.sourceErrorCode,
          checkpoint.retryableProviderFailureStreak,
        );
      }
    };
    const runKernelTextPrompt = async (
      promptText: string,
      phase: string,
      partition: "execution" | "review" | "finalization" = "execution",
    ): Promise<string> => {
      try {
        return await runTextPrompt(promptText, phase, partition);
      } catch (error) {
        if (!isPromptUsageModelCallBudgetError(error) && !isRetryableProviderFailure(error)) {
          throw error;
        }
        if (
          isPromptUsageModelCallBudgetError(error) &&
          !canRolloverDirectTurnBudget(context.turnBudget, error)
        ) {
          throw error;
        }
        const checkpoint = await persistSchedulerContinuation({
          input,
          deps,
          turnId: context.turnId,
          turnBudget: context.turnBudget,
          audit,
          publicDecisionContext,
          activeTurnContract: turnContractContext.current,
          expectedGeneration: context.continuationAtom?.generation,
          nextSemanticBlockSequenceFloor: nextSemanticBlockSequence(),
          error,
          obligationFrontier: obligationToolSurfaceState(),
        });
        throw new TurnSchedulerContinuationYieldError(
          input.handle.sessionId,
          context.turnId,
          checkpoint.contextAtomId,
          checkpoint.checkpointId,
          checkpoint.generation,
          checkpoint.sourceErrorCode,
          checkpoint.retryableProviderFailureStreak,
        );
      }
    };
    const initialPromptPhase = phaseBudgetController?.initialPromptPhase() ?? "initial_tool_loop";
    let candidateText: string;
    let btccTerminalText: string | null = null;
    let activeTurnContract: ActiveTurnContract | null = null;
    let resumeCandidateId: string | undefined;
    const candidateReviewResume = finalCandidateReviewResume({
      butlerData: deps.butlerData,
      turnId: context.turnId,
      continuationAtom: context.continuationAtom,
    });
    if (candidateReviewResume) {
      candidateText = candidateReviewResume.candidate_text;
      resumeCandidateId = candidateReviewResume.candidate_id;
      toolLoopUsed = useTools;
      if (candidateReviewResume.contract_id) {
        const atom = context.continuationAtom;
        if (!atom?.turnDecision || atom.contractId !== candidateReviewResume.contract_id) {
          throw new Error("final_candidate_review_contract_resume_state_missing");
        }
        activeTurnContract = restoreTurnContractExecution({
          butlerData: deps.butlerData,
          contractId: candidateReviewResume.contract_id,
          decision: atom.turnDecision,
          nextSemanticBlockSequence: atom.nextSemanticBlockSequence ?? 1,
          turnMetadata: input.metadata,
          toolSurfaceController: context.toolSurfaceController,
        });
        turnContractContext.current = activeTurnContract;
      }
      await emitTurnEventBestEffort(input, {
        kind: "turn.observation",
        visibility: "internal",
        payload: {
          kind: "final_candidate_review_resumed",
          safeLabel: "Resuming final review",
          candidateId: candidateReviewResume.candidate_id,
        },
      });
    } else if (useTools && session.init.role === "butler" && input.provider.capabilities.supportsStructuredOutputs === true) {
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
        runPrivateFunctionDecisionPrompt,
        runKernelToolPrompt,
        preparedBtccTurn,
        obligationToolSurfaceState,
        audit,
      });
      candidateText = typedEntry.candidateText;
      activeTurnContract = typedEntry.activeTurnContract;
      if (preparedBtccTurn) {
        const coordinator = new BtccNativePhaseCoordinator(preparedBtccTurn, deps.butlerData);
        if (coordinator.state().currentPhase === "planning") {
          throw new Error("btcc_planning_synthesis_missing");
        }
        if (coordinator.state().currentPhase === "execution") {
          coordinator.completeExecution({
            active: activeTurnContract,
            candidateText,
            audit,
            modelCallRefs: [toolLoopUsed
              ? `model-call:execution:${context.turnId}`
              : `runtime-call:execution:${context.turnId}`],
          });
        }
      }
    } else if (useTools && input.provider.capabilities.supportsStructuredOutputs === false) {
      throw new Error("provider_capability_missing");
    } else {
      candidateText = useTools
        ? await runKernelToolPrompt(context.prompt, undefined, initialPromptPhase)
        : await runTextPrompt(context.prompt);
    }
    if (preparedBtccTurn && activeTurnContract) {
      const coordinator = new BtccNativePhaseCoordinator(preparedBtccTurn, deps.butlerData);
      let reviewIndex = 0;
      let consolidationRepairIndex = 0;
      btccPhaseCycle: while (true) {
      while (coordinator.state().currentPhase === "review") {
        reviewIndex += 1;
        const review = await runBtccIndependentReview({
          coordinator,
          candidateText,
          audit,
          reviewIndex,
          runPrivateTextPrompt,
        });
        if (review.outcome === "passed") {
          coordinator.completeReview({
            candidateText,
            evidenceRefs: review.evidenceRefs,
            modelCallRefs: [review.modelCallRef],
          });
          break;
        }
        coordinator.returnReview({
          ownerPhase: review.ownerPhase,
          reasonCode: review.reasonCode,
          requiredChange: review.requiredChange,
          criterionId: review.criterionId,
          criterionIds: review.failedCriterionIds,
          evidenceRefs: review.evidenceRefs,
          gapFingerprint: review.gapFingerprint,
          modelCallRef: review.modelCallRef,
        });
        if (review.ownerPhase === "planning") {
          const frontier = obligationToolSurfaceState();
          const synthesis = await runBtccPlanningSynthesis({
            butlerData: deps.butlerData,
            coordinator,
            active: activeTurnContract,
            frontier,
            audit,
            runPrivateTextPrompt,
          });
          coordinator.completePlanning({
            active: activeTurnContract,
            frontier,
            audit,
            modelCallRefs: [synthesis.modelCallRef],
            taskGraph: synthesis.taskGraph,
          });
        }
        const repairPrompt = [
          coordinator.executionPrompt(activeTurnContract),
          "## Accepted Review ReturnTicket",
          JSON.stringify({
            ownerPhase: review.ownerPhase,
            criterionId: review.criterionId,
            reasonCode: review.reasonCode,
            requiredChange: review.requiredChange,
            evidenceRefs: review.evidenceRefs,
          }),
        ].join("\n\n");
        candidateText = activeTurnContract.contract.action === "answer"
          ? await runKernelTextPrompt(repairPrompt, "btcc_execution_repair")
          : await runKernelToolPrompt(repairPrompt, undefined, "btcc_execution_repair");
        coordinator.completeExecution({
          active: activeTurnContract,
          candidateText,
          audit,
          modelCallRefs: [`model-call:execution-repair:${context.turnId}:${reviewIndex}`],
        });
      }
      if (coordinator.state().currentPhase === "consolidation") {
        const consolidation = await runBtccConsolidation({
          coordinator,
          candidateText,
          audit,
          runPrivateTextPrompt,
        });
        if (consolidation.outcome === "complete") {
          coordinator.completeConsolidation({
            finalDossier: consolidation.dossier,
            evidenceRefs: consolidation.evidenceRefs,
            modelCallRefs: [consolidation.modelCallRef],
          });
        } else {
          const { gap } = consolidation;
          consolidationRepairIndex += 1;
          coordinator.returnConsolidation({
            ownerPhase: gap.ownerPhase,
            reasonCode: gap.reasonCode,
            requiredChange: gap.requiredChange,
            criterionIds: gap.criterionIds,
            evidenceRefs: gap.evidenceRefs,
            gapFingerprint: gap.gapFingerprint,
            modelCallRef: consolidation.modelCallRef,
          });
          if (gap.ownerPhase === "planning") {
            const frontier = obligationToolSurfaceState();
            const synthesis = await runBtccPlanningSynthesis({
              butlerData: deps.butlerData,
              coordinator,
              active: activeTurnContract,
              frontier,
              audit,
              runPrivateTextPrompt,
            });
            coordinator.completePlanning({
              active: activeTurnContract,
              frontier,
              audit,
              modelCallRefs: [synthesis.modelCallRef],
              taskGraph: synthesis.taskGraph,
            });
          }
          const repairPrompt = [
            coordinator.executionPrompt(activeTurnContract),
            "## Accepted Consolidation ReturnTicket",
            JSON.stringify(gap),
          ].join("\n\n");
          candidateText = activeTurnContract.contract.action === "answer"
            ? await runKernelTextPrompt(repairPrompt, "btcc_execution_consolidation_repair")
            : await runKernelToolPrompt(
              repairPrompt,
              undefined,
              "btcc_execution_consolidation_repair",
            );
          coordinator.completeExecution({
            active: activeTurnContract,
            candidateText,
            audit,
            modelCallRefs: [
              `model-call:execution-consolidation-repair:${context.turnId}:${consolidationRepairIndex}`,
            ],
          });
          continue btccPhaseCycle;
        }
      }
      if (coordinator.state().currentPhase === "reporting") {
        let guardFeedback: BtccReportGuardGap | undefined;
        let priorReportHash: string | null = null;
        let reportIndex = 0;
        while (true) {
          reportIndex += 1;
          const report = await runBtccReporter({
            coordinator,
            priorCandidateText: candidateText,
            guardFeedback,
            runPrivateTextPrompt,
            reportIndex,
          });
          const repairedReport = repairFinalContract({
            turnInput: input,
            session,
            deps,
            useTools: toolLoopUsed,
            prompt: context.prompt,
            finalText: report.text,
            audit,
            publicDecisionContext,
          });
          const guardedReport = applyPublicOutputGuards({
            turnInput: input,
            session,
            deps,
            useTools: toolLoopUsed,
            userText: context.userText,
            finalText: repairedReport,
            audit,
          });
          const reportHash = createHash("sha256").update(guardedReport).digest("hex");
          if (priorReportHash === reportHash) {
            throw new Error("btcc_reporting_unchanged_candidate_blocked");
          }
          priorReportHash = reportHash;
          const guard = await runBtccReportGuard({
            coordinator,
            reportText: guardedReport,
            runPrivateTextPrompt,
            guardIndex: reportIndex,
          });
          if (guard.outcome === "passed") {
            coordinator.completeReporting({
              reportText: guardedReport,
              validationPayload: {
                status: "passed",
                reporterCallRef: report.modelCallRef,
                reportingItemRefs: report.reportingItemRefs,
                evidenceRefs: report.evidenceRefs,
                deterministicPublicGuards: "passed",
              },
              guardPayload: {
                status: "passed",
                summary: guard.summary,
                criterionVerdicts: guard.criterionVerdicts,
                reportHash,
              },
              evidenceRefs: [
                ...audit.flatMap((entry) => entry.evidenceReceipts?.map((receipt) => receipt.id) ?? []),
                ...audit.flatMap((entry) => entry.evidenceCapabilityReceipts?.map((receipt) => receipt.receipt_id) ?? []),
              ],
              reporterCallRef: report.modelCallRef,
              guardCallRef: guard.modelCallRef,
            });
            btccTerminalText = guardedReport;
            break;
          }
          const failedCriteria = new Set(
            guard.criterionVerdicts
              .filter((criterion) => criterion.status === "failed")
              .map((criterion) => criterion.criterionId),
          );
          coordinator.returnReporting({
            reasonCode: guard.reasonCode,
            requiredChange: guard.requiredChange,
            criterionIds: [...failedCriteria],
            gapFingerprint: guard.gapFingerprint,
            modelCallRef: guard.modelCallRef,
          });
          guardFeedback = guard;
        }
      }
      if (btccTerminalText !== null) break btccPhaseCycle;
      const unresolvedPhase = coordinator.state().currentPhase;
      if (unresolvedPhase !== "review" && unresolvedPhase !== "consolidation" &&
        unresolvedPhase !== "reporting") {
        throw new Error(`btcc_phase_dispatch_unresolved:${unresolvedPhase}`);
      }
      }
    }
    throwIfRuntimeTurnAborted(input.signal);
    turnKernel.transitionTo("observing_tools");
    let decisionCheckedText: string | null = null;
    if (btccTerminalText !== null) {
      if (activeTurnContract) {
        const terminalCoordinator = preparedBtccTurn
          ? new BtccNativePhaseCoordinator(preparedBtccTurn, deps.butlerData)
          : null;
        const reviewReceiptRef = terminalCoordinator?.acceptedReceiptRef("review") ?? null;
        const reportingReceiptRef = terminalCoordinator?.acceptedReceiptRef("reporting") ?? null;
        if (!reviewReceiptRef || !reportingReceiptRef) {
          throw new Error("btcc_terminal_phase_receipts_missing");
        }
        activeTurnContract.contract = recordTurnContractBtccPhaseEvidence({
          butlerData: deps.butlerData,
          contract: activeTurnContract.contract,
          reviewReceiptRef,
          reportingReceiptRef,
        });
        activeTurnContract.contract = recordTurnContractAuditEvidence({
          butlerData: deps.butlerData,
          contract: activeTurnContract.contract,
          audit,
          finalCandidate: "",
        });
        activeTurnContract.contract = recordTurnContractBtccPhaseEvidence({
          butlerData: deps.butlerData,
          contract: activeTurnContract.contract,
          reviewReceiptRef,
          reportingReceiptRef,
        });
        activeTurnContract.contract = completeTurnContractDelivery({
          butlerData: deps.butlerData,
          active: activeTurnContract,
          turnId,
        });
        completeReportingWorkStreamBestEffort({
          butlerData: deps.butlerData,
          sessionId: input.handle.sessionId,
          turnId,
          audit,
        });
      }
      decisionCheckedText = btccTerminalText;
    } else while (true) {
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
        resumeCandidateId,
        turnBudget: context.turnBudget,
      });
      if (deliveryOutcome.kind === "final") {
        if (activeTurnContract) {
          activeTurnContract.contract = completeTurnContractDelivery({
            butlerData: deps.butlerData,
            active: activeTurnContract,
            turnId,
          });
          completeReportingWorkStreamBestEffort({
            butlerData: deps.butlerData,
            sessionId: input.handle.sessionId,
            turnId,
            audit,
          });
          decisionCheckedText = deliveryOutcome.text;
          break;
        }
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
      const continuationEvidence = buildTurnContinuationEvidence({
        audit,
        publicDecisions: publicDecisionContext,
      });
      await emitTurnEventBestEffort(input, {
        kind: "turn.observation",
        visibility: "internal",
        payload: {
          kind: deliveryOutcome.observation.kind,
          safeLabel: deliveryOutcome.observation.summary,
          modelVisibleContentChars: deliveryOutcome.observation.modelVisibleContent.length,
        },
      });
      if (activeTurnContract && deliveryOutcome.observation.nextMode !== "final_synthesis") {
        activeTurnContract.contract = resumeTurnContractExecution({
          butlerData: deps.butlerData,
          active: activeTurnContract,
        });
      }
      const continuationPromptInput = {
        userText: context.userText,
        activeTurnContract,
        observationSummary: deliveryOutcome.observation.summary,
        modelVisibleContent: deliveryOutcome.observation.modelVisibleContent,
        continuationEvidence: continuationEvidence.modelVisibleContent,
      };
      candidateText = deliveryOutcome.observation.nextMode === "final_synthesis"
        ? await runKernelTextPrompt(
          completionGapFinalSynthesisPrompt(continuationPromptInput),
          "completion_gap_final_synthesis",
          "finalization",
        )
        : await runKernelToolPrompt(
          completionGapContinuationPrompt(continuationPromptInput),
          undefined,
          gapPhase,
        );
      throwIfRuntimeTurnAborted(input.signal);
      turnKernel.transitionTo("continuing");
      turnKernel.transitionTo("model_deciding");
      turnKernel.transitionTo("observing_tools");
    }
    if (decisionCheckedText === null) {
      throw new Error("completion delivery exited without terminal outcome");
    }
    if (activeTurnContract && activeTurnContract.contract.state !== "delivered" &&
      activeTurnContract.contract.state !== "cancelled") {
      activeTurnContract.contract = completeTurnContractDelivery({
        butlerData: deps.butlerData,
        active: activeTurnContract,
        turnId,
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
    const principalCancelled = Boolean(
      input.signal?.aborted && turnId &&
      principalTurnCancellationRecorded({ butlerData: deps.butlerData, turnId }),
    );
    if (principalCancelled) {
      if (toolLoopUsed) {
        cancelActiveWorkStreamBestEffort({
          butlerData: deps.butlerData,
          sessionId: input.handle.sessionId,
          turnId,
        });
      }
      await emitInterruptedTurnOutcome({
        turnInput: input,
        cancelled: true,
        reason: "turn_cancelled_by_principal",
        turnKernel,
      });
      await emitTurnEventBestEffort(input, {
        kind: "turn.cancelled",
        payload: { safeLabel: "Cancelled" },
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
  } finally {
    preparedBtccTurn?.close();
  }
}

function finalCandidateReviewResume(input: {
  butlerData: string;
  turnId: string;
  continuationAtom: ReturnType<typeof readTurnContextAtom>;
}) {
  const reference = input.continuationAtom?.finalCandidateReview;
  if (!reference) return null;
  const candidate = readCurrentFinalCandidate({
    butlerData: input.butlerData,
    turnId: input.turnId,
  });
  if (!candidate || candidate.candidate_id !== reference.candidateId ||
    candidate.review_job.job_id !== reference.reviewJobId) {
    throw new Error("final_candidate_review_resume_owner_conflict");
  }
  if (!new Set(["pending_review", "reviewing", "accepted", "delivery_pending"]).has(candidate.state)) {
    return null;
  }
  return candidate;
}

function isRetryableProviderFailure(error: unknown): boolean {
  const failure = safeRuntimeFailure(error);
  return failure.retryable === true;
}

async function persistSchedulerContinuation(input: {
  input: NativeTurnRunnerInput["input"];
  deps: NativeTurnRunnerInput["deps"];
  turnId: string;
  turnBudget: DirectTurnBudget;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
  activeTurnContract: ActiveTurnContract | null;
  expectedGeneration?: number;
  nextSemanticBlockSequenceFloor?: number;
  error: unknown;
  obligationFrontier: ObligationToolSurfaceState;
}): Promise<{
  contextAtomId: string;
  checkpointId: string;
  generation: number;
  sourceErrorCode: string;
  retryableProviderFailureStreak: number;
}> {
  const finalCandidateReview = readCurrentFinalCandidate({
    butlerData: input.deps.butlerData,
    turnId: input.turnId,
  });
  const safeFailure = isPromptUsageModelCallBudgetError(input.error)
    ? reviewAwareBudgetFailure(input.error, input.turnBudget)
    : safeRuntimeFailure(input.error);
  const contextAtomId = createTurnContextAtomId(input.input.handle.sessionId, input.turnId);
  if (input.activeTurnContract) {
    input.activeTurnContract.contract = recordTurnContractAuditEvidence({
      butlerData: input.deps.butlerData,
      contract: input.activeTurnContract.contract,
      audit: input.audit,
      finalCandidate: finalCandidateReview?.candidate_text ?? "",
    });
  }
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
    roundJournal: buildDurableTurnRoundJournal({
      audit: input.audit,
      publicDecisions: input.publicDecisionContext,
    }),
    budgetSnapshot: isPromptUsageModelCallBudgetError(input.error)
      ? snapshotDirectTurnBudgetForRollover(input.turnBudget)
      : snapshotDirectTurnBudget(input.turnBudget),
    ...(input.activeTurnContract
      ? continuationContractState({
        butlerData: input.deps.butlerData,
        active: input.activeTurnContract,
        publicDecisionContext: input.publicDecisionContext,
        nextSemanticBlockSequenceFloor: input.nextSemanticBlockSequenceFloor,
      })
      : {}),
    providerAdapterId: input.input.provider.id,
    effectiveModel: input.input.model,
    ...(finalCandidateReview
      ? {
        finalCandidateReview: {
          candidateId: finalCandidateReview.candidate_id,
          reviewJobId: finalCandidateReview.review_job.job_id,
          state: finalCandidateReview.state,
          revision: finalCandidateReview.revision,
        },
      }
      : {}),
    obligationFrontier: input.obligationFrontier,
    expectedGeneration: input.expectedGeneration,
    unresolvedObservations: [{
      kind: "context_compacted",
      id: `context-atom:${contextAtomId}`,
    }],
  });
  if (!persistedContextAtomId) throw new Error("turn_continuation_commit_missing");
  const committed = readTurnContextAtom({
    butlerData: input.deps.butlerData,
    sessionId: input.input.handle.sessionId,
    turnId: input.turnId,
  });
  if (!committed) throw new Error("turn_continuation_commit_missing");
  if (input.activeTurnContract) {
    input.activeTurnContract.contract = commitTurnContractContinuation({
      butlerData: input.deps.butlerData,
      contractId: input.activeTurnContract.contract.contract_id,
      commitId: committed.checkpointId,
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
  return {
    contextAtomId,
    checkpointId: committed.checkpointId,
    generation: committed.generation,
    sourceErrorCode: safeFailure.code,
    retryableProviderFailureStreak: committed.retryableProviderFailureStreak ?? 0,
  };
}

function reviewAwareBudgetFailure(
  error: unknown,
  budget: DirectTurnBudget,
): { code: string; message: string } {
  const record = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : {};
  if (record.partition !== "review") {
    return {
      code: "prompt_usage_model_call_budget_exhausted",
      message: "Provider request safety window exhausted.",
    };
  }
  const review = budget.partitions.review;
  const admittedPromptTokens = finiteNumber(record.admittedPromptTokens);
  const requestedOutputTokens = finiteNumber(record.requestedOutputTokens);
  const dimension = budget.modelRequestsUsed + 1 > budget.maxModelCalls ||
      review.modelRequestsUsed + 1 > review.maxModelCalls
    ? "request_count"
    : budget.promptTokens + admittedPromptTokens > budget.maxPromptTokens ||
        review.promptTokens + admittedPromptTokens > review.maxPromptTokens
    ? "prompt_tokens"
    : budget.outputTokens + requestedOutputTokens > budget.maxOutputTokens ||
        review.outputTokens + requestedOutputTokens > review.maxOutputTokens
    ? "output_tokens"
    : "total_tokens";
  return {
    code: `review_request_${dimension}_lease_exhausted`,
    message: `The persisted final-candidate review node exhausted its ${dimension} lease.`,
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function continuationContractState(input: {
  butlerData: string;
  active: ActiveTurnContract;
  publicDecisionContext: PublicWorkDecision[];
  nextSemanticBlockSequenceFloor?: number;
}) {
  const workStreamId = input.active.contract.target_workstream_id;
  const stream = workStreamId
    ? new WorkStreamStore(input.butlerData).read(workStreamId)
    : null;
  const providerRounds = input.publicDecisionContext
    .map((decision) => decision.providerRound)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    contractId: input.active.contract.contract_id,
    turnDecision: input.active.decision,
    ...(workStreamId ? { workStreamId } : {}),
    ...(stream?.todo_list_id ? { todoListId: stream.todo_list_id } : {}),
    nextSemanticBlockSequence: Math.max(
      input.nextSemanticBlockSequenceFloor ?? 1,
      Math.max(0, ...providerRounds) + 1,
    ),
  };
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

function hasSchedulerContinuationMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return Boolean(metadata?.schedulerContinuation && typeof metadata.schedulerContinuation === "object");
}

function isSchedulerContinuation(
  input: NativeTurnRunnerInput["input"],
  continuationAtom: ReturnType<typeof readTurnContextAtom>,
): boolean {
  return Boolean(
    continuationAtom &&
      input.metadata?.schedulerContinuation &&
      typeof input.metadata.schedulerContinuation === "object",
  );
}

async function emitCommittedContinuationScheduledEvent(input: {
  turnInput: NativeTurnRunnerInput["input"];
  continuationAtom: ReturnType<typeof readTurnContextAtom>;
}): Promise<void> {
  const metadata = input.turnInput.metadata?.schedulerContinuation;
  if (!metadata || typeof metadata !== "object" || !input.continuationAtom) return;
  const record = metadata as Record<string, unknown>;
  const checkpointId = typeof record.checkpointId === "string" ? record.checkpointId.trim() : "";
  const schedulerItemId = typeof record.schedulerItemId === "string" ? record.schedulerItemId.trim() : "";
  if (!checkpointId || !schedulerItemId) return;
  if (checkpointId !== input.continuationAtom.checkpointId) {
    throw new Error("turn_continuation_checkpoint_mismatch");
  }
  await emitTurnEventBestEffort(input.turnInput, {
    kind: "turn.continuation_scheduled",
    payload: {
      checkpointId,
      schedulerItemId,
      contextAtomId: createTurnContextAtomId(
        input.continuationAtom.sessionId,
        input.continuationAtom.turnId,
      ),
      safeLabel: "Continuation checkpoint scheduled.",
    },
  });
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

function activeWorkStreamBinding(active: ActiveTurnContract | null) {
  const workStreamId = active?.contract.target_workstream_id?.trim();
  if (!active || !workStreamId) return null;
  return {
    contractId: active.contract.contract_id,
    workStreamId,
  };
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
