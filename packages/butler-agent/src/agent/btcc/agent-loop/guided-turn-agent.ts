import { createGuidedEffectService } from "../effects/index.ts";
import type { BtccAgentLoop, BtccAgentLoopInput, BtccAgentLoopResult } from "./contracts.ts";
import { createButlerToolExecutor } from "../../tools/butler-tools.ts";
import { ActiveProjectLedgerResolver } from "../../../integrations/project-ledger/active-project-ledger-reference.ts";
import { createProviderModelRoundPort } from "../../../integrations/providers/runtime.ts";
import { providerImageAttachments, renderGuidedResponseLanguage } from "./guided-turn-prompt.ts";
import { directSynthesisToolDefinitions, GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES, guidedNativeToolDefinitions, hiddenNativeToolNamesForGuidedTurn } from "./guided-turn-policy.ts";
import { selectGuidedTurnPhasePolicy } from "./guided-phase-policy.ts";
import { createGuidedToolExecutionBoundary } from "./guided-tool-execution-boundary.ts";
import { executeGuidedCommandCall } from "./guided-command-execution.ts";
import { renderGuidedEffectContext } from "./guided-effect-context.ts";
import { renderDurableWorkContext } from "./durable-work-tools.ts";
import { loadGuidedTurnWork, safeBoundWork, workScopeForTurn } from "./guided-work-runtime.ts";
import { createGuidedToolCallExecutor } from "./guided-tool-call-execution.ts";
import { runGuidedAgentLoopWithOperationalReport } from "./guided-operational-report.ts";
import { createGuidedActivityProjection } from "../projection/index.ts";
import { createGuidedPersistentEffectResolver } from "./guided-persistent-effect-resolution.ts";
import { createGuidedExecutionWindowObserver } from "./execution-window-observation.ts";
import { createGuidedSessionWorkspaceRuntime } from "./guided-session-workspace-recovery.ts";
import { createGuidedOperationResultRuntime } from "../operation-result-replay/index.ts";
import type { ProductionGuidedTurnAgentInput } from "./guided-turn-agent-input.ts";
import type { ModelRoundPort } from "../ports/model-round.ts";
import { guidedContinuationBudget } from "./guided-continuation-budget.ts";
import { guidedTurnResult } from "./guided-turn-result.ts";
import { createGuidedModelRouteRuntime } from "./guided-turn-route-events.ts";
import { createGuidedDelegationTurnRelease, createGuidedTurnCloseout } from "./guided-turn-closeout.ts";
import { createActiveDelegationAdmissionGuard, createGuidedRoundToolSurfaceResolver } from "./guided-round-tool-surface.ts";
import { renderPhaseScopedGuidedTurnRequest } from "./phase-scoped-memory-projection.ts";
import { createFileStoreVerifiedImagePayloadPort } from "../../image-attachment/index.ts";
import { createGuidedAskFirstProgress, createGuidedAuthorityProjection, createGuidedOperationalProgressCapture } from "./guided-operational-progress.ts";
import { loadGuidedOperationalFacts } from "./guided-operational-facts.ts";
import { collectGuidedFinalArtifacts } from "./guided-final-artifacts.ts";
import { recordRuntimeMemoryEvent } from "./runtime-memory-attribution-events.ts";
import { privateModifyContinuationPromptInput } from "./guided-authority-continuation.ts";
import type { PrincipalAuthority } from "../authority/index.ts";
import { ensureSubsessionChildRootWork, stewardSafeBoundary, subsessionToolInput } from "../subsessions/index.ts";
import { withStewardDirection } from "./guided-steward-direction.ts";
type TestGuidedTurnAgentInput = Omit<ProductionGuidedTurnAgentInput, "authority"> & { modelRound: ModelRoundPort };
export function createProductionGuidedTurnAgent(input: ProductionGuidedTurnAgentInput): BtccAgentLoop;
export function createProductionGuidedTurnAgent(input: TestGuidedTurnAgentInput): BtccAgentLoop;
export function createProductionGuidedTurnAgent(
  input: ProductionGuidedTurnAgentInput | TestGuidedTurnAgentInput,
): BtccAgentLoop {
  const authority = "authority" in input ? input.authority : undefined;
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
      const subsessionResultEvidence = await input.subsessionDelegation?.resolveParentResultEvidence({ parentSessionId: turn.sessionId, parentInputText: turn.originalMessage });
      const phasePolicy = selectGuidedTurnPhasePolicy(turn);
      const policy = phasePolicy.executionPolicy;
      const askFirstTurn = policy.accessMode === "ask_first";
      const progressCapture = createGuidedOperationalProgressCapture(
        askFirstTurn
          ? createGuidedAskFirstProgress(progress)
          : progress,
      );
      const observedProgress = progressCapture.observer;
      const continuationBudget = guidedContinuationBudget(
        turn,
        transitionContinuationBudget,
      );
      if (phasePolicy.exactResultReplay.mode === "available" &&
        (!turn.modelRoute || !loadModelRoundAcceptance || !recordModelRoundAcceptance)) {
        throw new Error("operation_result_route_acceptance_dependency_missing");
      }
      const workspaceReference = await sessionWorkspace.recover({ sessionId: turn.sessionId, projectWorkspacePath: policy.workspacePath, signal });
      const workScope = workScopeForTurn(turn, policy.trackingMode);
      if (policy.role === "steward" && input.subsessionDelegation) await ensureSubsessionChildRootWork({ service: input.subsessionDelegation, turn });
      const { context: initialWork, bound: initialWorkBound } = await loadGuidedTurnWork({
        durableWork: input.durableWork,
        toolJournal: input.toolJournal,
        scope: workScope,
        trackingMode: policy.trackingMode,
        authority,
        authorityRequestRef: turn.context.authorityRequestRef,
        authorityClientMessageId: turn.context.authorityClientMessageId,
        workspacePath: workspaceReference.get(),
      });
      const operationResults = createGuidedOperationResultRuntime({
        ...phasePolicy.exactResultReplay,
        turnId: turn.turnId,
        turnRevision: turn.revision,
        journal: input.toolJournal,
        exactReader: input.operationResultReader,
        sessionId: turn.sessionId,
        projectRef: policy.projectId ?? turn.context.projectRef,
      });
      const authorizedTools = subsessionResultEvidence ? directSynthesisToolDefinitions(phasePolicy.authorizedTools) : phasePolicy.authorizedTools;
      const authorizedNames = new Set(authorizedTools.map((tool) => tool.name));
      const visibleTools = subsessionResultEvidence ? directSynthesisToolDefinitions(phasePolicy.providerTools) : phasePolicy.providerTools;
      const visibleNames = new Set(visibleTools.map((tool) => tool.name));
      const describedToolIds = new Set<string>();
      const activeDelegationAdmission = createActiveDelegationAdmissionGuard();
      const effectService = createGuidedEffectService(input.effectJournal, input.guidedEffectFaultHook ? { faultHook: input.guidedEffectFaultHook } : {});
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
        ...subsessionToolInput(input.subsessionDelegation, turn, policy.accessMode),
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
          authority: authority!, ownerSessionId: turn.sessionId, sourceTurnId: turn.turnId,
          authorityClientMessageId: turn.context.authorityClientMessageId,
          modelRef: `${turn.modelSelection.provider}/${turn.modelSelection.model}`, reasoningEffort: turn.modelSelection.reasoningEffort,
          workspacePath: workspaceReference.get(),
          toolJournal: input.toolJournal,
          ...(turn.context.authorityRequestRef
            ? { authorityRequestRef: turn.context.authorityRequestRef }
            : {}),
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
      const activity = createGuidedActivityProjection({ turnId: turn.turnId, progress: observedProgress, managedInitially: initialWorkBound, nextSourceRevision });
      const authorityProjection = createGuidedAuthorityProjection({
        accessMode: policy.accessMode,
        activity,
        authority: projectionAuthority(
          authority,
          turn.sessionId,
          turn.context.authorityClientMessageId,
        ),
        ownerSessionId: turn.sessionId,
        turnId: turn.turnId,
        ...(turn.context.authorityRequestRef
          ? { requestRef: turn.context.authorityRequestRef }
          : {}),
      });
      const baseModelRound = input.modelRound ?? createProviderModelRoundPort();
      const {
        modelRound,
        activeModelRef: resolveActiveModelRef,
        selectedReasoningEffort,
        acceptedModelIdentity,
      } = createGuidedModelRouteRuntime({
        turn,
        baseModelRound,
        progress: observedProgress,
        nextSourceRevision,
        recordModelRouteEvent,
        loadModelRouteAttemptHistory,
        loadModelRoundAcceptance,
        recordModelRoundAcceptance,
      });
      const toolCalls = createGuidedToolCallExecutor({
        turn,
        signal,
        resolveModelRef: resolveActiveModelRef,
        progress: observedProgress,
        activity: authorityProjection.publicActivity,
        workScope,
        authorizedNames,
        visibleNames,
        describedToolIds,
        durableWork: input.durableWork,
        toolJournal: input.toolJournal,
        workspacePath: workspaceReference.get, butlerData: input.butlerData,
        executeButlerTool: execute,
      });
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
          ...(subsessionResultEvidence ? { subsessionResultEvidence } : {}),
          ...privateModifyContinuationPromptInput(
            authority, turn.sessionId, turn.context.authorityRequestRef, turn.turnId,
            turn.context.authorityClientMessageId,
          ),
        },
        initialRequestBytes: modelRound.initialRequestBytes,
        butlerData: input.butlerData,
      });
      const closeout = createGuidedTurnCloseout({
        durableWork: input.durableWork, toolJournal: input.toolJournal, workScope,
        turnId: turn.turnId, originalRequest: turn.originalMessage,
        trackingMode: policy.trackingMode, responseLanguage,
      });
      const delegationRelease = createGuidedDelegationTurnRelease({ reconcileAfterLoop: closeout.reconcileAfterLoop, responseLanguage, originalRequest: turn.originalMessage });
      const resolveGuidedTools = phasePolicy.mode === "phase_minimal" ||
        visibleTools.some((tool) => tool.name === "delegate_to_steward")
        ? createGuidedRoundToolSurfaceResolver({
            turnId: turn.turnId, tools: visibleTools, workScope, durableWork: input.durableWork,
            requiredToolNames: new Set(policy.requiredNativeTools), toolJournal: input.toolJournal, effectJournal: input.effectJournal,
            projectWorkSurface: phasePolicy.mode === "phase_minimal",
            parentSessionId: turn.sessionId,
            subsessionDelegation: input.subsessionDelegation,
            onActiveDelegationAdmission: activeDelegationAdmission.observe,
          })
        : undefined;
      const directionAware = withStewardDirection({ modelRound, safeBoundary: stewardSafeBoundary({ service: input.subsessionDelegation, turn }), reviewFinalCandidate: closeout.reviewFinalCandidate });
      const loopOptions: BtccAgentLoopInput = {
        prompt: requestAttribution.prompt,
        phaseContinuityPrivateDigester: input.phaseContinuityPrivateDigester,
        turnId: turn.turnId,
        instructions: requestAttribution.instructions,
        recoveryAttempt,
        progress: observedProgress,
        model: resolveActiveModelRef(),
        resolveModelRef: resolveActiveModelRef,
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
        ...(resolveGuidedTools ? { resolveTools: resolveGuidedTools } : {}),
        // This is an internal execution-window size. The same Turn remains
        // active across windows until the model reaches a final answer.
        maxIterations: Math.max(1, input.executionWindowSize ?? 60),
        modelRound: directionAware.modelRound,
        operationResultReplay: operationResults.replay,
        ...(continuationBudget ? { continuationBudget } : {}),
        resolveOperationResultCallId: toolCalls.journalCallIdForProviderCall,
        onExecutionWindowBoundary: createGuidedExecutionWindowObserver({
          durableWork: input.durableWork, workScope, turnId: turn.turnId,
          trackingMode: policy.trackingMode, signal,
        }),
        ...authorityProjection.loopCallbacks,
        finalTextFromToolResult: delegationRelease.finalTextFromToolResult(authorityProjection.loopCallbacks.finalTextFromToolResult),
        reviewFinalCandidate: directionAware.reviewFinalCandidate,
        executeTool: activeDelegationAdmission.execute(toolCalls.executeTool),
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
      const text = await delegationRelease.reconcileAfterLoop(candidate);
      const publicText = authorityProjection.project(text);
      const terminalOutcome = turn.context.emptyResponsePolicy === "typed_terminal" &&
        !text.trim()
        ? "no_visible" as const
        : undefined;
      const finalWork = await safeBoundWork(input.durableWork, turn.turnId);
      const artifacts = collectGuidedFinalArtifacts(input.toolJournal.list(turn.turnId));
      return guidedTurnResult({
        content: publicText,
        ...(terminalOutcome && !authorityProjection.continuation ? { terminalOutcome } : {}),
        ...(finalWork?.status === "completed" || finalWork?.status === "blocked"
          ? { workStatus: finalWork.status }
          : {}),
        artifacts,
        modelIdentity: acceptedModelIdentity(),
        usedTools: toolCalls.usedTools,
        hasFinalWork: Boolean(finalWork),
      });
    },
  };
}
function projectionAuthority(authority: PrincipalAuthority | undefined, sourceSessionId: string, clientMessageId: string | undefined): PrincipalAuthority | undefined {
  if (!authority || !clientMessageId) return authority;
  return { ...authority, execution: (input) => authority.execution({ ...input, sourceSessionId: input.sourceSessionId ?? sourceSessionId, clientMessageId: input.clientMessageId ?? clientMessageId }) };
}
