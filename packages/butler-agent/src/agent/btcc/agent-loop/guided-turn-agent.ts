import { createGuidedEffectService } from "../effects/index.ts";
import type { BtccAgentLoop, BtccAgentLoopInput, BtccAgentLoopResult } from "./contracts.ts";
import { createButlerToolExecutor } from "../../tools/butler-tools.ts";
import { ActiveProjectLedgerResolver } from
  "../../../integrations/project-ledger/active-project-ledger-reference.ts";
import { createProviderModelRoundPort } from
  "../../../integrations/providers/runtime.ts";
import {
  providerImageAttachments,
  renderGuidedResponseLanguage,
  renderGuidedTurnRequestAttribution,
} from "./guided-turn-prompt.ts";
import {
  GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES,
  guidedNativeToolDefinitions,
  hiddenNativeToolNamesForGuidedTurn,
  routeForUsedTools,
  selectedModelRef,
} from "./guided-turn-policy.ts";
import { selectGuidedTurnPhasePolicy } from "./guided-phase-policy.ts";
import { createGuidedToolExecutionBoundary } from
  "./guided-tool-execution-boundary.ts";
import { executeGuidedCommandCall } from "./guided-command-execution.ts";
import { renderGuidedEffectContext } from "./guided-effect-context.ts";
import { renderDurableWorkContext } from "./durable-work-tools.ts";
import { isDurableWorkTool } from "../work/index.ts";
import {
  backfillTurnToolResults,
  safeImportOpenLegacyWork,
  safeBoundWork,
  safeLoadWorkContext,
  workScopeForTurn,
} from "./guided-work-runtime.ts";
import { createGuidedToolCallExecutor } from
  "./guided-tool-call-execution.ts";
import { runGuidedAgentLoopWithOperationalReport } from
  "./guided-operational-report.ts";
import { createGuidedActivityProjection } from
  "../projection/index.ts";
import { createGuidedPersistentEffectResolver } from
  "./guided-persistent-effect-resolution.ts";
import {
  createModelRoutePort,
  currentModelRouteCandidate,
  type ModelRouteEvent,
} from "../model-route/index.ts";
import { createGuidedExecutionWindowObserver } from "./execution-window-observation.ts";
import { createGuidedSessionWorkspaceRuntime } from "./guided-session-workspace-recovery.ts";
import {
  createGuidedOperationResultRuntime,
} from "../operation-result-replay/index.ts";
import type { ProductionGuidedTurnAgentInput } from "./guided-turn-agent-input.ts";
import { guidedContinuationBudget } from "./guided-continuation-budget.ts";

export function createProductionGuidedTurnAgent(
  input: ProductionGuidedTurnAgentInput,
): BtccAgentLoop {
  const projectLedgerResolver = new ActiveProjectLedgerResolver();
  const sessionWorkspace = createGuidedSessionWorkspaceRuntime({ butlerData: input.butlerData, bindingStore: input.sessionBindingStore });
  return {
    async run({
      turn,
      signal,
      progress,
      recordModelRouteEvent,
      loadModelRouteAttemptHistory,
      loadModelRoundAcceptance,
      recordModelRoundAcceptance,
      transitionContinuationBudget,
      onProviderResponseIdentity,
    }): Promise<BtccAgentLoopResult> {
      const phasePolicy = selectGuidedTurnPhasePolicy(turn);
      const continuationBudget = guidedContinuationBudget(
        turn,
        transitionContinuationBudget,
      );
      if (phasePolicy.exactResultReplay.mode === "available" &&
        (!turn.modelRoute || !loadModelRoundAcceptance || !recordModelRoundAcceptance)) {
        throw new Error("operation_result_route_acceptance_dependency_missing");
      }
      const policy = phasePolicy.executionPolicy;
      const workspaceReference = await sessionWorkspace.recover({ sessionId: turn.sessionId, projectWorkspacePath: policy.workspacePath, signal });
      const workScope = workScopeForTurn(turn, policy.trackingMode);
      let initialWork = policy.trackingMode === "none"
        ? null
        : await safeLoadWorkContext(input.durableWork, workScope);
      if (!initialWork && policy.trackingMode !== "none") {
        await safeImportOpenLegacyWork(input.durableWork, workScope);
        initialWork = await safeLoadWorkContext(input.durableWork, workScope);
      }
      const operationResults = createGuidedOperationResultRuntime({
        ...phasePolicy.exactResultReplay,
        turnId: turn.turnId,
        turnRevision: turn.revision,
        journal: input.toolJournal,
        exactReader: input.operationResultReader,
        sessionId: turn.sessionId,
        projectRef: policy.projectId ?? turn.context.projectRef,
      });
      let initialWorkBound = false;
      if (initialWork) {
        const boundWork = await safeBoundWork(input.durableWork, turn.turnId);
        initialWorkBound = boundWork?.workId === initialWork.work.workId;
        if (initialWorkBound) {
          await backfillTurnToolResults(input, workScope);
          initialWork = await safeLoadWorkContext(input.durableWork, workScope);
        }
      }
      const presentedWorkId = initialWork?.work.workId;
      const authorizedTools = phasePolicy.authorizedTools;
      const authorizedNames = new Set(authorizedTools.map((tool) => tool.name));
      const visibleTools = phasePolicy.providerTools;
      const visibleNames = new Set(visibleTools.map((tool) => tool.name));
      const describedToolIds = new Set<string>();
      const effectService = createGuidedEffectService(input.effectJournal);
      const execute = createButlerToolExecutor({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        workspacePath: policy.workspacePath,
        sessionId: turn.sessionId,
        originChatId: turn.sessionId,
        projectId: policy.projectId ?? turn.context.projectRef,
        workspaceReference,
        sessionBindingStore: sessionWorkspace.bindingStore,
        operationResultExactReader: operationResults.read,
        turnId: turn.turnId,
        turnContext: turn.originalMessage,
        searchPlanner: async () => ({
          plan: null,
          usedPlanner: false,
          attempts: 0,
          fallbackReason: "guided model owns search planning",
        }),
        currentToolNames: () => [...authorizedNames],
        nativeToolDefinitions: guidedNativeToolDefinitions(
          phasePolicy.exactResultReplay.exactReadCapability,
        ),
        hiddenNativeToolNames: hiddenNativeToolNamesForGuidedTurn(
          policy.accessMode === "full_access" &&
            policy.trackingMode === "ledger" &&
            Boolean(policy.projectId),
        ),
        nativeToolAvailabilityOverrides:
          GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES,
        describedToolIds: () => [...describedToolIds],
        executionBoundary: createGuidedToolExecutionBoundary({
          durableWork: input.durableWork,
          workScope,
          effectService,
          accessMode: policy.accessMode,
          signal,
          executeCommand: (call) => executeGuidedCommandCall({
            call,
            accessMode: policy.accessMode,
            butlerData: input.butlerData,
            workspacePath: workspaceReference.get(),
            originalRequest: turn.originalMessage,
            signal,
          }),
          resolvePersistentEffect: createGuidedPersistentEffectResolver({
            butlerHome: input.butlerHome,
            butlerData: input.butlerData,
            workspacePath: policy.workspacePath,
            workspaceReference,
            sessionId: turn.sessionId,
            sessionBindingStore: sessionWorkspace.bindingStore,
            projectId: policy.projectId,
            trackingMode: policy.trackingMode,
            projectLedgerResolver,
            effectJournal: input.effectJournal,
            originalRequest: turn.originalMessage,
          }),
        }),
      });
      const activity = createGuidedActivityProjection({
        turnId: turn.turnId,
        progress,
        managedInitially: initialWorkBound,
      });
      let activeModelRef = selectedModelRef(turn);
      let acceptedModelIdentity: BtccAgentLoopResult["modelIdentity"];
      const toolCalls = createGuidedToolCallExecutor({
        turn,
        signal,
        resolveModelRef: () => activeModelRef,
        progress,
        activity,
        workScope,
        presentedWorkId,
        authorizedNames,
        visibleNames,
        describedToolIds,
        durableWork: input.durableWork,
        toolJournal: input.toolJournal,
        executeButlerTool: execute,
      });
      const baseModelRound = input.modelRound ?? createProviderModelRoundPort();
      const routedCandidate = turn.modelRoute
        ? currentModelRouteCandidate(turn.modelRoute)
        : undefined;
      const selectedReasoningEffort = routedCandidate?.reasoningEffort ??
        turn.modelSelection.reasoningEffort;
      let pendingFallbackProjection: { roundId: string; modelRef: string } | undefined;
      const onRouteEvent = async (event: ModelRouteEvent) => {
        const persisted = await recordModelRouteEvent?.(event);
        if (
          event.type === "model.attempt.started" &&
          pendingFallbackProjection?.roundId === event.roundId &&
          pendingFallbackProjection.modelRef === event.modelRef
        ) {
          pendingFallbackProjection = undefined;
          try {
            await progress?.modelRoundWaitingChanged?.({
              turnId: turn.turnId,
              requestId: event.roundId,
              status: "started",
              modelRef: event.modelRef,
            });
          } catch {
            // Public model identity cannot veto the provider dispatch.
          }
        }
        if (event.type === "model.fallback.selected") {
          activeModelRef = event.modelRef;
          pendingFallbackProjection = {
            roundId: event.roundId,
            modelRef: event.modelRef,
          };
          try {
            await progress?.phaseActivityChanged?.({
              turnId: turn.turnId,
              semanticState: turn.semanticState,
              activityId: `${turn.turnId}:model-fallback:${event.roundId}:${event.candidateIndex}`,
              title: "대체 모델 경로 선택",
              summary: `${event.modelRef} 모델로 계속 진행합니다.`,
              modelRef: event.modelRef,
            });
          } catch {
            // Public fallback notice cannot veto the next provider dispatch.
          }
        }
        return persisted;
      };
      const modelRound = turn.modelRoute
        ? createModelRoutePort({
            base: baseModelRound,
            turnId: turn.turnId,
            route: turn.modelRoute,
            onRouteEvent,
            loadAttemptHistory: loadModelRouteAttemptHistory,
            loadAcceptedResponse: loadModelRoundAcceptance,
            recordAcceptedResponse: recordModelRoundAcceptance
              ? async (accepted) => {
                  await recordModelRoundAcceptance(accepted);
                  acceptedModelIdentity = {
                    requestedModelRef: `${turn.modelSelection.provider}/${turn.modelSelection.model}`,
                    effectiveModelRef: accepted.modelRef,
                    ...(accepted.result.providerIdentity
                      ? {
                          providerReportedModelRef:
                            accepted.result.providerIdentity.reportedModel.includes("/")
                              ? accepted.result.providerIdentity.reportedModel
                              : `${accepted.result.providerIdentity.provider}/${accepted.result.providerIdentity.reportedModel}`,
                        }
                      : {}),
                  };
                }
              : undefined,
          })
        : baseModelRound;
      const responseLanguage = renderGuidedResponseLanguage(turn, input.contextDocuments);
      const requestAttribution = renderGuidedTurnRequestAttribution(
        turn,
        phasePolicy.stableInstructionPrefix,
        responseLanguage,
        {
          ...input,
          workContext: renderDurableWorkContext(initialWork),
          effectContext: initialWork
            ? renderGuidedEffectContext(
                input.effectJournal.listForWork(initialWork.work.workId),
            )
            : "",
        },
      );
      const loopOptions: BtccAgentLoopInput = {
        prompt: requestAttribution.prompt,
        turnId: turn.turnId,
        instructions: requestAttribution.instructions,
        requestSegmentSources: requestAttribution.requestSegmentSources,
        progress,
        model: activeModelRef,
        resolveModelRef: () => activeModelRef,
        reasoningEffort: selectedReasoningEffort,
        usageAttribution: {
          turnId: turn.turnId,
          phase: "guided",
          reasoningEffort: selectedReasoningEffort,
        },
        cacheScope: `btcc-guided:${turn.sessionId}`,
        attributionArmId: turn.context.providerRequestAttribution?.armId,
        cacheBoundaryEvidence: turn.context.providerRequestAttribution?.cacheBoundaryEvidence,
        stableProviderCachePrefix: phasePolicy.stableProviderCachePrefix,
        signal,
        butlerData: input.butlerData,
        attachments: providerImageAttachments(turn),
        onProviderResponseIdentity,
        tools: visibleTools,
        // This is an internal execution-window size. The same Turn remains
        // active across windows until the model reaches a final answer.
        maxIterations: Math.max(1, input.executionWindowSize ?? 60),
        modelRound,
        operationResultReplay: operationResults.replay,
        ...(continuationBudget ? { continuationBudget } : {}),
        resolveOperationResultCallId: toolCalls.journalCallIdForProviderCall,
        onExecutionWindowBoundary: createGuidedExecutionWindowObserver({
          durableWork: input.durableWork, workScope, turnId: turn.turnId,
          trackingMode: policy.trackingMode, signal,
        }),
        onAssistantTextBeforeTools: ({ text, toolCalls: calls }) => activity.observeToolBatch({
          text,
          toolCalls: calls.map((call) => ({
            name: call.name,
            args: call.arguments,
          })),
        }),
        executeTool: async (call) => await toolCalls.executeTool({
          name: call.name,
          args: call.arguments,
          rawArguments: call.rawArguments,
          providerCallId: call.id,
          signal: call.signal,
        }),
      };
      const text = await runGuidedAgentLoopWithOperationalReport({
        options: loopOptions,
        parentSignal: signal,
        originalRequest: turn.originalMessage,
        async loadFacts() {
          const currentWork = await safeLoadWorkContext(input.durableWork, workScope) ??
            await safeBoundWork(input.durableWork, turn.turnId) ?? initialWork;
          const workId = currentWork && "work" in currentWork
            ? currentWork.work.workId
            : currentWork?.workId;
          return {
            work: currentWork,
            toolCalls: input.toolJournal.list(turn.turnId),
            effects: workId ? input.effectJournal.listForWork(workId) : [],
            responseLanguage,
          };
        },
      });
      const finalWork = await safeBoundWork(input.durableWork, turn.turnId);
      return {
        content: text,
        ...(acceptedModelIdentity ? { modelIdentity: acceptedModelIdentity } : {}),
        route: routeForUsedTools(
          toolCalls.usedTools,
          Boolean(finalWork) ||
            toolCalls.usedTools.some(isDurableWorkTool),
        ),
      };
    },
  };
}
