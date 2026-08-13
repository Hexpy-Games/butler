import { isDurableWorkTool, type DurableWorkService } from "../work/index.ts";
import type { BtccAgentLoop, BtccAgentLoopInput, BtccAgentLoopResult } from "./contracts.ts";
import type { ModelRoundPort } from "../ports/model-round.ts";
import { createGuidedEffectService } from "../effects/index.ts";
import { createButlerToolExecutor } from "../../tools/butler-tools.ts";
import type { SqliteGuidedEffectJournal, SqliteGuidedToolJournal } from "../../adapters/index.ts";
import { ActiveProjectLedgerResolver } from "../../../integrations/project-ledger/active-project-ledger-reference.ts";
import { createProviderModelRoundPort } from "../../../integrations/providers/runtime.ts";
import { createFileStoreVerifiedImagePayloadPort } from
  "../../image-attachment/index.ts";
import {
  guidedInstructions,
  providerImageAttachments,
  renderGuidedPersonaInstructions,
  renderGuidedResponseLanguage,
  renderGuidedPrompt,
} from "./guided-turn-prompt.ts";
import {
  authorizedToolDefinitions,
  GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES,
  guidedNativeToolDefinitions,
  guidedPolicy,
  hiddenNativeToolNamesForGuidedTurn,
  isZaiMcpVisionTurn,
  routeForUsedTools,
  selectedModelRef,
  visibleToolDefinitions,
} from "./guided-turn-policy.ts";
import { createGuidedToolExecutionBoundary } from
  "./guided-tool-execution-boundary.ts";
import { executeGuidedCommandCall } from "./guided-command-execution.ts";
import { renderGuidedEffectContext } from "./guided-effect-context.ts";
import { renderDurableWorkContext } from "./durable-work-tools.ts";
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
} from "../model-route/index.ts";
import { renderExecutionWindowObservation } from "./execution-window-observation.ts";
import { createGuidedTurnCloseout } from "./guided-turn-closeout.ts";
import {
  createGuidedRouteEventHandler,
  createGuidedRouteRecoveryHandler,
} from "./guided-turn-route-events.ts";
import { createGuidedOperationalProgressCapture } from
  "./guided-operational-progress.ts";
import { throwIfExecutionWindowAborted } from "./execution-window.ts";
import {
  guidedOperationalFallbackAfterInternalId,
  loadGuidedOperationalFacts,
} from "./guided-operational-facts.ts";
import { collectGuidedFinalArtifacts } from "./guided-final-artifacts.ts";
import { createGuidedSessionWorkspaceRuntime, type GuidedSessionWorkspaceBindingStore } from "./guided-session-workspace-recovery.ts";

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
      turn, recoveryAttempt,
      signal,
      progress,
      recordModelRouteEvent,
      loadModelRouteAttemptHistory,
      loadModelRoundAcceptance,
      recordModelRoundAcceptance,
      onProviderResponseIdentity,
    }): Promise<BtccAgentLoopResult> {
      const progressCapture = createGuidedOperationalProgressCapture(progress);
      const observedProgress = progressCapture.observer;
      const policy = guidedPolicy(turn);
      const workspaceReference = await sessionWorkspace.recover({ sessionId: turn.sessionId, projectWorkspacePath: policy.workspacePath, signal });
      const workScope = workScopeForTurn(turn, policy.trackingMode);
      let initialWork = policy.trackingMode === "none"
        ? null
        : await safeLoadWorkContext(input.durableWork, workScope);
      if (!initialWork && policy.trackingMode !== "none") {
        await safeImportOpenLegacyWork(input.durableWork, workScope);
        initialWork = await safeLoadWorkContext(input.durableWork, workScope);
      }
      let initialWorkBound = false;
      if (initialWork) {
        const boundWork = await safeBoundWork(input.durableWork, turn.turnId);
        initialWorkBound = boundWork?.workId === initialWork.work.workId;
        if (initialWorkBound) {
          await backfillTurnToolResults(input, workScope);
          initialWork = await safeLoadWorkContext(input.durableWork, workScope);
        }
      }
      const authorizedTools = authorizedToolDefinitions(turn);
      const authorizedNames = new Set(authorizedTools.map((tool) => tool.name));
      const visibleTools = visibleToolDefinitions(authorizedTools, policy, isZaiMcpVisionTurn(turn));
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
      let progressSourceRevision = 0;
      const nextSourceRevision = () => ++progressSourceRevision;
      const activity = createGuidedActivityProjection({
        turnId: turn.turnId,
        progress: observedProgress,
        managedInitially: initialWorkBound,
        nextSourceRevision,
      });
      let activeModelRef = selectedModelRef(turn);
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
        setActiveModelRef: (modelRef) => {
          activeModelRef = modelRef;
        },
        recordModelRouteEvent,
      });
      const modelRound = turn.modelRoute
        ? createModelRoutePort({
            base: baseModelRound,
            turnId: turn.turnId,
            route: turn.modelRoute,
            onRouteEvent,
            loadAttemptHistory: loadModelRouteAttemptHistory,
            loadAcceptedResponse: loadModelRoundAcceptance,
            recordAcceptedResponse: recordModelRoundAcceptance,
            onRecoveryChanged: createGuidedRouteRecoveryHandler({
              turnId: turn.turnId,
              semanticState: turn.semanticState,
              progress: observedProgress,
            }),
          })
        : baseModelRound;
      const responseLanguage = renderGuidedResponseLanguage(
        turn,
        input.contextDocuments,
      );
      const closeout = createGuidedTurnCloseout({
        durableWork: input.durableWork,
        workScope,
        turnId: turn.turnId,
        trackingMode: policy.trackingMode,
      });
      const loopOptions: BtccAgentLoopInput = {
        prompt: renderGuidedPrompt(turn, {
          ...input,
          workContext: renderDurableWorkContext(initialWork),
          effectContext: initialWork
            ? renderGuidedEffectContext(
                input.effectJournal.listForWork(initialWork.work.workId),
            )
            : "",
        }),
        turnId: turn.turnId,
        recoveryAttempt,
        instructions: guidedInstructions(
          policy,
          renderGuidedPersonaInstructions(turn, input.contextDocuments),
          responseLanguage,
        ),
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
        signal,
        butlerData: input.butlerData,
        attachments: providerImageAttachments(turn),
        ...(turn.context.imageAdmission ? { imageCarrier: turn.context.imageAdmission.tuple, imageCapability: turn.context.imageAdmission.capability } : {}),
        imageManifests: providerImageAttachments(turn).flatMap((a) => a.visualManifest ? [a.visualManifest] : []),
        verifiedImagePayloadPort: createFileStoreVerifiedImagePayloadPort(input.butlerData),
        onProviderResponseIdentity,
        tools: visibleTools,
        // This is an internal execution-window size. The same Turn remains
        // active across windows until the model reaches a final answer.
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
          return renderExecutionWindowObservation({
            windowIndex,
            context: refreshedContext,
            boundWork: refreshedBoundWork,
          });
        },
        onAssistantTextBeforeTools: ({ text, toolCalls: calls }) =>
          activity.observeToolBatch({
            text,
            toolCalls: calls.map((call) => ({ name: call.name, args: call.arguments })),
          }),
        reviewFinalCandidate: closeout.reviewFinalCandidate,
        executeTool: async (call) => {
          return toolCalls.executeTool({
            name: call.name,
            args: call.arguments,
            rawArguments: call.rawArguments,
            providerCallId: call.id,
            signal: call.signal,
          });
        },
      };
      const text = await runGuidedAgentLoopWithOperationalReport({
        options: loopOptions,
        parentSignal: signal,
        originalRequest: turn.originalMessage,
        loadFacts: () => loadGuidedOperationalFacts({
          turnId: turn.turnId,
          readBoundWork: () => safeBoundWork(input.durableWork, turn.turnId),
          listToolCalls: () => input.toolJournal.list(turn.turnId),
          listEffectsForWork: (workId) => input.effectJournal.listForWork(workId),
          readProgress: () => progressCapture.facts(),
          responseLanguage,
        }),
      });
      await closeout.recordMissingDiagnostic();
      const finalWork = await safeBoundWork(input.durableWork, turn.turnId);
      const internalWorkIds = [initialWork?.work.workId, finalWork?.workId]
        .filter((workId): workId is string => Boolean(workId));
      const content = internalWorkIds.some((workId) => text.includes(workId))
        ? await guidedOperationalFallbackAfterInternalId({
            originalRequest: turn.originalMessage,
            turnId: turn.turnId,
            responseLanguage,
            finalWork,
            internalWorkIds,
            listToolCalls: () => input.toolJournal.list(turn.turnId),
            listEffectsForWork: (workId) => input.effectJournal.listForWork(workId),
            readProgress: () => progressCapture.facts(),
          })
        : text;
      const artifacts = collectGuidedFinalArtifacts(
        input.toolJournal.list(turn.turnId),
      );
      return {
        content,
        ...(artifacts.length > 0 ? { artifacts } : {}),
        route: routeForUsedTools(
          toolCalls.usedTools,
          Boolean(finalWork) ||
            toolCalls.usedTools.some(isDurableWorkTool),
        ),
      };
    },
  };
}
