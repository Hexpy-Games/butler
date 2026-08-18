import { createGuidedEffectService } from "../effects/index.ts";
import type { BtccAgentLoop, BtccAgentLoopInput, BtccAgentLoopResult } from "./contracts.ts";
import { createButlerToolExecutor } from "../../tools/butler-tools.ts";
import { ActiveProjectLedgerResolver } from "../../../integrations/project-ledger/active-project-ledger-reference.ts";
import { createProviderModelRoundPort } from "../../../integrations/providers/runtime.ts";
import {
  providerImageAttachments,
  renderGuidedResponseLanguage,
} from "./guided-turn-prompt.ts";
import {
  GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES,
  guidedNativeToolDefinitions,
  hiddenNativeToolNamesForGuidedTurn,
  selectedModelRef,
} from "./guided-turn-policy.ts";
import { selectGuidedTurnPhasePolicy } from "./guided-phase-policy.ts";
import { createGuidedToolExecutionBoundary } from "./guided-tool-execution-boundary.ts";
import { executeGuidedCommandCall } from "./guided-command-execution.ts";
import { renderGuidedEffectContext } from "./guided-effect-context.ts";
import { renderDurableWorkContext } from "./durable-work-tools.ts";
import {
  loadInitialGuidedWork,
  safeBoundWork,
  workScopeForTurn,
} from "./guided-work-runtime.ts";
import { createGuidedToolCallExecutor } from "./guided-tool-call-execution.ts";
import { runGuidedAgentLoopWithOperationalReport } from "./guided-operational-report.ts";
import { createGuidedActivityProjection } from
  "../projection/index.ts";
import { createGuidedPersistentEffectResolver } from "./guided-persistent-effect-resolution.ts";
import { createModelRoutePort, currentModelRouteCandidate } from "../model-route/index.ts";
import { createGuidedExecutionWindowObserver } from "./execution-window-observation.ts";
import { createGuidedSessionWorkspaceRuntime } from "./guided-session-workspace-recovery.ts";
import { createGuidedOperationResultRuntime } from "../operation-result-replay/index.ts";
import type { ProductionGuidedTurnAgentInput } from "./guided-turn-agent-input.ts";
import { guidedContinuationBudget } from "./guided-continuation-budget.ts";
import { guidedTurnResult } from "./guided-turn-result.ts";
import { createGuidedRouteEventHandler, createGuidedRouteRecoveryHandler } from "./guided-turn-route-events.ts";
import { createGuidedTurnCloseout } from "./guided-turn-closeout.ts";
import { createGuidedRoundToolSurfaceResolver } from "./guided-round-tool-surface.ts";
import { renderPhaseScopedGuidedTurnRequest } from "./phase-scoped-memory-projection.ts";
import { createFileStoreVerifiedImagePayloadPort } from "../../image-attachment/index.ts";
import { createGuidedOperationalProgressCapture } from "./guided-operational-progress.ts";
import { loadGuidedOperationalFacts } from "./guided-operational-facts.ts";
import { collectGuidedFinalArtifacts } from "./guided-final-artifacts.ts";
import { recordRuntimeMemoryEvent } from "./runtime-memory-attribution-events.ts";

export function createProductionGuidedTurnAgent(
  input: ProductionGuidedTurnAgentInput,
): BtccAgentLoop {
  const projectLedgerResolver = new ActiveProjectLedgerResolver();
  const sessionWorkspace = createGuidedSessionWorkspaceRuntime({ butlerData: input.butlerData, bindingStore: input.sessionBindingStore });
  return {
    async run({
      turn, recoveryAttempt,
      signal,
      memoryAttribution,
      progress,
      recordModelRouteEvent,
      loadModelRouteAttemptHistory,
      loadModelRoundAcceptance,
      recordModelRoundAcceptance,
      transitionContinuationBudget,
      onProviderResponseIdentity,
    }): Promise<BtccAgentLoopResult> {
      const progressCapture = createGuidedOperationalProgressCapture(progress);
      const observedProgress = progressCapture.observer;
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
      const initialWorkState = policy.trackingMode === "none"
        ? { context: null, bound: false }
        : await loadInitialGuidedWork(input, workScope);
      const initialWork = initialWorkState.context;
      const operationResults = createGuidedOperationResultRuntime({
        ...phasePolicy.exactResultReplay,
        turnId: turn.turnId,
        turnRevision: turn.revision,
        journal: input.toolJournal,
        exactReader: input.operationResultReader,
        sessionId: turn.sessionId,
        projectRef: policy.projectId ?? turn.context.projectRef,
      });
      const initialWorkBound = initialWorkState.bound;
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
        imageManifests: providerImageAttachments(turn).flatMap((a) => a.visualManifest ? [a.visualManifest] : []),
        ...(turn.context.imageAdmission ? { imageCarrier: turn.context.imageAdmission.tuple, imageCapability: turn.context.imageAdmission.capability } : {}),
        verifiedImagePayloadPort: createFileStoreVerifiedImagePayloadPort(input.butlerData),
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
          executeCommand: (call, executeRegistered) => executeGuidedCommandCall({
            call,
            accessMode: policy.accessMode,
            butlerData: input.butlerData,
            workspacePath: workspaceReference.get(),
            originalRequest: turn.originalMessage,
            signal,
            executeRegistered,
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
            memoryAttribution,
          }),
        }),
      });
      let progressSourceRevision = 0;
      const nextSourceRevision = () => ++progressSourceRevision;
      const activity = createGuidedActivityProjection({
        turnId: turn.turnId,
        progress: observedProgress,
        managedInitially: initialWorkBound,
        nextSourceRevision,
      });
      let activeModelRef = selectedModelRef(turn);
      let acceptedModelIdentity: BtccAgentLoopResult["modelIdentity"];
      const toolCalls = createGuidedToolCallExecutor({
        turn,
        signal,
        resolveModelRef: () => activeModelRef,
        progress: observedProgress,
        activity,
        workScope,
        authorizedNames,
        visibleNames,
        describedToolIds,
        durableWork: input.durableWork,
        toolJournal: input.toolJournal,
        workspacePath: workspaceReference.get, butlerData: input.butlerData,
        executeButlerTool: execute,
      });
      const baseModelRound = input.modelRound ?? createProviderModelRoundPort();
      const routedCandidate = turn.modelRoute
        ? currentModelRouteCandidate(turn.modelRoute)
        : undefined;
      const selectedReasoningEffort = routedCandidate?.reasoningEffort ??
        turn.modelSelection.reasoningEffort;
      const onRouteEvent = createGuidedRouteEventHandler({
        turnId: turn.turnId,
        semanticState: turn.semanticState,
        progress: observedProgress,
        nextSourceRevision,
        recordModelRouteEvent,
        setActiveModelRef(modelRef) {
          activeModelRef = modelRef;
        },
      });
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
            onRecoveryChanged: createGuidedRouteRecoveryHandler({
              turnId: turn.turnId,
              semanticState: turn.semanticState,
              progress: observedProgress,
            }),
          })
        : baseModelRound;
      const responseLanguage = renderGuidedResponseLanguage(turn, input.contextDocuments);
      const effectContext = initialWork
        ? renderGuidedEffectContext(input.effectJournal.listForWork(initialWork.work.workId))
        : "";
      const requestAttribution = renderPhaseScopedGuidedTurnRequest({
        enabled: Boolean(continuationBudget), phase: phasePolicy.phase, turn,
        stableInstructionPrefix: phasePolicy.stableInstructionPrefix,
        responseLanguage,
        promptInput: {
          ...input, workContext: renderDurableWorkContext(initialWork), effectContext,
        },
        initialRequestBytes: modelRound.initialRequestBytes,
        butlerData: input.butlerData,
      });
      const closeout = createGuidedTurnCloseout({
        durableWork: input.durableWork, toolJournal: input.toolJournal, workScope,
        turnId: turn.turnId, originalRequest: turn.originalMessage,
        trackingMode: policy.trackingMode, responseLanguage,
      });
      const loopOptions: BtccAgentLoopInput = {
        prompt: requestAttribution.prompt,
        phaseContinuityPrivateDigester: input.phaseContinuityPrivateDigester,
        turnId: turn.turnId,
        instructions: requestAttribution.instructions,
        recoveryAttempt,
        progress: observedProgress,
        model: activeModelRef,
        resolveModelRef: () => activeModelRef,
        reasoningEffort: selectedReasoningEffort,
        usageAttribution: {
          turnId: turn.turnId,
          phase: "guided",
          reasoningEffort: selectedReasoningEffort,
        },
        cacheScope: `btcc-guided:${turn.sessionId}`,
        stableProviderCachePrefix: phasePolicy.stableProviderCachePrefix,
        signal,
        butlerData: input.butlerData,
        attachments: providerImageAttachments(turn),
        ...(turn.context.imageAdmission ? { imageCarrier: turn.context.imageAdmission.tuple, imageCapability: turn.context.imageAdmission.capability } : {}),
        imageManifests: providerImageAttachments(turn).flatMap((a) => a.visualManifest ? [a.visualManifest] : []),
        verifiedImagePayloadPort: createFileStoreVerifiedImagePayloadPort(input.butlerData),
        onProviderResponseIdentity,
        onEvent: (event) => recordRuntimeMemoryEvent(memoryAttribution, event),
        tools: visibleTools,
        ...(phasePolicy.mode === "phase_minimal"
          ? {
              resolveTools: createGuidedRoundToolSurfaceResolver({
                turnId: turn.turnId, tools: visibleTools,
                requiredToolNames: new Set(policy.requiredNativeTools), toolJournal: input.toolJournal,
                durableWork: input.durableWork,
                workScope,
                effectJournal: input.effectJournal,
              }),
            }
          : {}),
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
        reviewFinalCandidate: closeout.reviewFinalCandidate,
        executeTool: async (call) => await toolCalls.executeTool({
          name: call.name,
          args: call.arguments,
          rawArguments: call.rawArguments,
          providerCallId: call.id,
          signal: call.signal,
        }),
      };
      const candidate = await runGuidedAgentLoopWithOperationalReport({
        options: loopOptions,
        parentSignal: signal,
        originalRequest: turn.originalMessage,
        emptyResponsePolicy: turn.context.emptyResponsePolicy,
        loadFacts: () => loadGuidedOperationalFacts({
          turnId: turn.turnId,
          readBoundWork: () => safeBoundWork(input.durableWork, turn.turnId),
          listToolCalls: () => input.toolJournal.list(turn.turnId),
          listEffectsForWork: (workId) => input.effectJournal.listForWork(workId),
          readProgress: () => progressCapture.facts(),
          responseLanguage,
        }),
      });
      const text = await closeout.reconcileAfterLoop(candidate);
      const terminalOutcome = turn.context.emptyResponsePolicy === "typed_terminal" &&
        !text.trim()
        ? "no_visible" as const
        : undefined;
      const finalWork = await safeBoundWork(input.durableWork, turn.turnId);
      const artifacts = collectGuidedFinalArtifacts(
        input.toolJournal.list(turn.turnId),
      );
      return guidedTurnResult({
        content: text,
        ...(terminalOutcome ? { terminalOutcome } : {}),
        artifacts,
        modelIdentity: acceptedModelIdentity,
        usedTools: toolCalls.usedTools,
        hasFinalWork: Boolean(finalWork),
      });
    },
  };
}
