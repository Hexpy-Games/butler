import type { DurableWorkService } from "../work/index.ts";
import type { BtccAgentLoopInput } from "./contracts.ts";
import type { ModelRoundPort } from "../ports/model-round.ts";
import { createGuidedEffectService } from "../effects/index.ts";
import type { BtccAgentLoop, BtccAgentLoopResult } from "./contracts.ts";
import { createButlerToolExecutor } from "../../tools/butler-tools.ts";
import type { SqliteGuidedEffectJournal, SqliteGuidedToolJournal } from "../../adapters/index.ts";
import { ActiveProjectLedgerResolver } from
  "../../../integrations/project-ledger/active-project-ledger-reference.ts";
import { createProviderModelRoundPort } from "../../../integrations/providers/runtime.ts";
import { providerImageAttachments } from "./guided-turn-prompt.ts";
import {
  GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES,
  guidedNativeToolDefinitions,
  guidedPolicy,
  hiddenNativeToolNamesForGuidedTurn,
  routeForUsedTools,
  selectGuidedToolSurface,
  selectedModelRef,
} from "./guided-turn-policy.ts";
import { createGuidedToolSurfaceObservation, type GuidedToolSurfaceObservation } from "./guided-tool-surface-observation.ts";
import { createGuidedToolExecutionBoundary } from
  "./guided-tool-execution-boundary.ts";
import { executeGuidedCommandCall } from "./guided-command-execution.ts";
import { isDurableWorkTool } from "../work/index.ts";
import {
  safeBoundWork,
  safeLoadWorkContext,
} from "./guided-work-runtime.ts";
import { createGuidedToolCallExecutor } from "./guided-tool-call-execution.ts";
import { runGuidedAgentLoopWithOperationalReport } from "./guided-operational-report.ts";
import { createGuidedActivityProjection } from
  "../projection/index.ts";
import { createGuidedPersistentEffectResolver } from
  "./guided-persistent-effect-resolution.ts";
import {
  currentModelRouteCandidate,
} from "../model-route/index.ts";
import { renderGuidedExecutionWindowObservation } from "./execution-window-observation.ts";
import { createGuidedSessionWorkspaceRuntime, type GuidedSessionWorkspaceBindingStore } from "./guided-session-workspace-recovery.ts";
import { createGuidedTurnBaselineObservation } from "./guided-turn-baseline-observation.ts";
import { isM1CompactReplayEnabled } from "../../tools/m1-compact-replay.ts";
import type { GuidedCompactReplayRuntime } from "./guided-compact-replay-runtime.ts";
import { assembleGuidedTurnContext } from "./guided-turn-context-assembly.ts";
import { observeCompactReplayToolBatch } from "./guided-compact-replay-control.ts";
import { throwIfExecutionWindowAborted } from "./execution-window.ts";
import {
  createBtccCompactReplayModelRoundPort,
} from "./model-round-request-assembly.ts";
import {
  admitGuidedTurnContinuation,
  createGuidedContinuationModelRound,
  observeGuidedTurnContinuation,
  type GuidedTurnContinuationObservation,
} from "./guided-turn-continuation.ts";
import { assembleGuidedTurnPrompt } from
  "./guided-turn-prompt-assembly.ts";
export function createProductionGuidedTurnAgent(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath: string;
  contextDocuments: { resolve(contextRef: string): string };
  toolJournal: SqliteGuidedToolJournal;
  effectJournal: SqliteGuidedEffectJournal;
  durableWork: DurableWorkService;
  modelRound?: ModelRoundPort;
  sessionBindingStore?: GuidedSessionWorkspaceBindingStore;
  /** Test seam for exercising more than one internal execution window. */
  executionWindowSize?: number;
}): BtccAgentLoop {
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
      executionClaim,
      onProviderResponseIdentity,
      observationStartedAtMs,
    }): Promise<BtccAgentLoopResult> {
      const routedCandidate = turn.modelRoute
        ? currentModelRouteCandidate(turn.modelRoute)
        : undefined;
      const selectedReasoningEffort = routedCandidate?.reasoningEffort ??
        turn.modelSelection.reasoningEffort;
      let activeModelRef = routedCandidate?.modelRef ?? selectedModelRef(turn);
      const m1Observation = createGuidedTurnBaselineObservation({
        butlerData: input.butlerData,
        modelRef: activeModelRef,
        reasoning: selectedReasoningEffort,
        startedAtMs: observationStartedAtMs,
        resolveModelRef: () => activeModelRef,
      });
      let m1ToolSurfaceAdmission: GuidedToolSurfaceObservation | undefined;
      let compactReplayRuntime: GuidedCompactReplayRuntime | undefined;
      let continuationObservation: GuidedTurnContinuationObservation | undefined;
      try {
      const policy = guidedPolicy(turn);
      const continuationSelection = admitGuidedTurnContinuation({
        turn, recordModelRouteEvent, loadModelRouteAttemptHistory,
        loadModelRoundAcceptance, recordModelRoundAcceptance, executionClaim,
      });
      const workspaceReference = await sessionWorkspace.recover({ sessionId: turn.sessionId, projectWorkspacePath: policy.workspacePath, signal });
      m1ToolSurfaceAdmission = createGuidedToolSurfaceObservation({
        butlerData: input.butlerData,
        modelRef: activeModelRef,
        policy,
        turn,
        workspaceReference,
      });
      const compactReplayEnabled = isM1CompactReplayEnabled(process.env);
      const contextAssembly = await assembleGuidedTurnContext({
        compactReplayEnabled,
        butlerData: input.butlerData,
        durableWork: input.durableWork,
        toolJournal: input.toolJournal,
        trackingMode: policy.trackingMode,
        turn, modelRef: activeModelRef, resolveModelRef: () => activeModelRef,
        ...(policy.projectId || turn.context.projectRef
          ? { projectRef: policy.projectId ?? turn.context.projectRef }
          : {}),
      });
      const { workScope, initialWork, initialWorkBound } = contextAssembly;
      compactReplayRuntime = contextAssembly.compactReplayRuntime;
      const compactReplay = compactReplayRuntime.context;
      const presentedWorkId = initialWork?.work.workId;
      const toolSurface = selectGuidedToolSurface(
        turn,
        process.env,
        workspaceReference,
        compactReplayEnabled,
      );
      const authorizedTools = toolSurface.authorizedTools;
      const authorizedNames = new Set(authorizedTools.map((tool) => tool.name));
      const visibleTools = toolSurface.providerTools;
      continuationObservation = observeGuidedTurnContinuation({
        selection: continuationSelection, turn, butlerData: input.butlerData,
        policy, compactReplayEnabled,
      });
      m1ToolSurfaceAdmission.observeProviderTools(visibleTools);
      const visibleNames = new Set(visibleTools.map((tool) => tool.name));
      const describedToolIds = new Set<string>();
      const effectService = createGuidedEffectService(input.effectJournal);
      const execute = createButlerToolExecutor({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        appMessageDbPath: input.appMessageDbPath,
        workspacePath: policy.workspacePath,
        sessionId: turn.sessionId,
        originChatId: turn.sessionId,
        projectId: policy.projectId ?? turn.context.projectRef,
        workspaceReference,
        sessionBindingStore: sessionWorkspace.bindingStore,
        turnId: turn.turnId,
        turnContext: turn.originalMessage,
        searchPlanner: async () => ({
          plan: null,
          usedPlanner: false,
          attempts: 0,
          fallbackReason: "guided model owns search planning",
        }),
        currentToolNames: () => [...authorizedNames],
        nativeToolDefinitions: guidedNativeToolDefinitions(),
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
            appMessageDbPath: input.appMessageDbPath,
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
        compactReplayRuntime,
        ...(continuationSelection.enabled
          ? { continuationBudget: { claim: executionClaim! } }
          : {}),
      });
      const baseModelRound = createBtccCompactReplayModelRoundPort(input.modelRound ?? createProviderModelRoundPort());
      const modelRound = createGuidedContinuationModelRound({
        base: baseModelRound, turn, progress, recordModelRouteEvent,
        observation: continuationObservation,
        onFallbackSelected: (event) => {
          m1Observation.markMeasurementIneligible();
          activeModelRef = event.modelRef;
        },
        loadAttemptHistory: loadModelRouteAttemptHistory,
        loadAcceptedResponse: loadModelRoundAcceptance,
        recordAcceptedResponse: recordModelRoundAcceptance,
        selection: continuationSelection,
      });
      const promptAssembly = assembleGuidedTurnPrompt({
        turn, policy, contextDocuments: input.contextDocuments,
        butlerData: input.butlerData, toolJournal: input.toolJournal,
        effectJournal: input.effectJournal, initialWork, compactReplay,
        compactReplayEnabled,
        compactReplayWorkCharacterLimit:
          compactReplayRuntime.budget.workContextCharacters,
        continuationEnabled: continuationSelection.enabled,
      });
      const loopOptions: BtccAgentLoopInput = {
        prompt: promptAssembly.prompt,
        turnId: turn.turnId,
        instructions: promptAssembly.instructions,
        progress,
        model: activeModelRef,
        resolveModelRef: () => activeModelRef,
        reasoningEffort: selectedReasoningEffort,
        usageAttribution: {
          turnId: turn.turnId,
          phase: "guided",
          reasoningEffort: selectedReasoningEffort,
          ...m1Observation.usageAttribution,
        },
        cacheScope: `btcc-guided:${turn.sessionId}`,
        signal,
        butlerData: input.butlerData,
        attachments: providerImageAttachments(turn),
        onProviderResponseIdentity,
        tools: visibleTools,
        compactReplay: {
          enabled: compactReplayEnabled, initialPhaseContinuity: compactReplay?.phaseContinuity ?? null,
          ...(compactReplay && { initialProjection: compactReplay.initialProjection }),
        },
        maxIterations: Math.max(1, input.executionWindowSize ?? 60),
        modelRound,
        onExecutionWindowBoundary: async ({ windowIndex }) => {
          throwIfExecutionWindowAborted(signal);
          const refreshedContext = policy.trackingMode === "none"
            ? null
            : await safeLoadWorkContext(input.durableWork, workScope);
          const refreshedBoundWork = policy.trackingMode === "none"
            ? null
            : await safeBoundWork(input.durableWork, turn.turnId);
          return renderGuidedExecutionWindowObservation({
            compactReplayEnabled, windowIndex,
            context: refreshedContext, boundWork: refreshedBoundWork,
          });
        },
        onAssistantTextBeforeTools: ({ text, toolCalls: calls }) =>
          observeCompactReplayToolBatch({
            activity,
            text,
            calls,
          }),
        onEvent: m1Observation.onEvent,
        executeTool: async (call) => await toolCalls.executeTool({
          name: call.name,
          args: call.arguments,
          rawArguments: call.rawArguments,
          providerCallId: call.id,
          operationBatchId: call.operationBatchId, operationBatchOrdinal: call.operationBatchOrdinal,
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
            responseLanguage: promptAssembly.responseLanguage,
          };
        },
      });
      const finalWork = await safeBoundWork(input.durableWork, turn.turnId);
      m1Observation.markSuccess();
      return {
        content: text,
        route: routeForUsedTools(
          toolCalls.usedTools,
          Boolean(finalWork) ||
            toolCalls.usedTools.some(isDurableWorkTool),
        ),
      };
      } catch (error) {
        continuationObservation?.observeError(error);
        throw error;
      } finally {
        continuationObservation?.finalize();
        compactReplayRuntime?.finalize(signal.aborted);
        m1ToolSurfaceAdmission?.finalize(signal.aborted ? "skipped" : "error");
        m1Observation.finalize(signal.aborted ? "skipped" : "error");
      }
    },
  };
}
