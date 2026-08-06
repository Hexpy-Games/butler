import type { DurableWorkService } from "../work/index.ts";
import type {
  BtccAgentLoopInput,
} from "./contracts.ts";
import type { DurableWorkContext, DurableWorkView } from "../work/index.ts";
import type { ModelRoundPort } from "../ports/model-round.ts";
import { createGuidedEffectService } from "../effects/index.ts";
import type { BtccAgentLoop, BtccAgentLoopResult } from "./contracts.ts";
import { createButlerToolExecutor } from "../../tools/butler-tools.ts";
import type { SqliteGuidedEffectJournal, SqliteGuidedToolJournal } from
  "../../adapters/index.ts";
import { ActiveProjectLedgerResolver } from
  "../../../integrations/project-ledger/active-project-ledger-reference.ts";
import { createProviderModelRoundPort } from
  "../../../integrations/providers/runtime.ts";
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
  routeForUsedTools,
  selectedModelRef,
  visibleToolDefinitions,
} from "./guided-turn-policy.ts";
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

export function createProductionGuidedTurnAgent(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath: string;
  contextDocuments: { resolve(contextRef: string): string };
  toolJournal: SqliteGuidedToolJournal;
  effectJournal: SqliteGuidedEffectJournal;
  durableWork: DurableWorkService;
  modelRound?: ModelRoundPort;
  /** Test seam for exercising more than one internal execution window. */
  executionWindowSize?: number;
}): BtccAgentLoop {
  const projectLedgerResolver = new ActiveProjectLedgerResolver();
  return {
    async run({
      turn,
      signal,
      progress,
      recordModelRouteEvent,
      loadModelRouteAttemptHistory,
      loadModelRoundAcceptance,
      recordModelRoundAcceptance,
      onProviderResponseIdentity,
    }): Promise<BtccAgentLoopResult> {
      const policy = guidedPolicy(turn);
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
      const presentedWorkId = initialWork?.work.workId;
      const authorizedTools = authorizedToolDefinitions(turn);
      const authorizedNames = new Set(authorizedTools.map((tool) => tool.name));
      const visibleTools = visibleToolDefinitions(authorizedTools, policy);
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
            workspacePath: policy.workspacePath,
            originalRequest: turn.originalMessage,
            signal,
          }),
          resolvePersistentEffect: createGuidedPersistentEffectResolver({
            butlerHome: input.butlerHome,
            butlerData: input.butlerData,
            appMessageDbPath: input.appMessageDbPath,
            workspacePath: policy.workspacePath,
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
            recordAcceptedResponse: recordModelRoundAcceptance,
          })
        : baseModelRound;
      const responseLanguage = renderGuidedResponseLanguage(
        turn,
        input.contextDocuments,
      );
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
        instructions: guidedInstructions(
          policy,
          renderGuidedPersonaInstructions(turn, input.contextDocuments),
          responseLanguage,
        ),
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
        signal,
        butlerData: input.butlerData,
        attachments: providerImageAttachments(turn),
        onProviderResponseIdentity,
        tools: visibleTools,
        // This is an internal execution-window size. The same Turn remains
        // active across windows until the model reaches a final answer.
        maxIterations: Math.max(1, input.executionWindowSize ?? 60),
        modelRound,
        onExecutionWindowBoundary: async ({ windowIndex }) => {
          if (signal.aborted) throwGuidedAbort(signal);
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
        route: routeForUsedTools(
          toolCalls.usedTools,
          Boolean(finalWork) ||
            toolCalls.usedTools.some(isDurableWorkTool),
        ),
      };
    },
  };
}

function renderExecutionWindowObservation(input: {
  windowIndex: number;
  context: DurableWorkContext | null;
  boundWork: DurableWorkView | null;
}): string {
  const work = input.context?.work ?? input.boundWork;
  const lines = [
    `Execution checkpoint ${input.windowIndex + 1}: use the existing conversation and evidence already collected for the original request.`,
  ];
  if (!work) {
    lines.push(
      "No durable Work checkpoint is available. Preserve the prior messages and evaluate the next useful step from the evidence already present.",
    );
    return lines.join("\n");
  }
  lines.push(`Durable Work status: ${work.status}.`);
  if (work.currentStage) lines.push(`Current stage: ${work.currentStage}.`);
  if (work.latestCheckpoint?.publicSummary) {
    lines.push(`Latest checkpoint: ${singleLine(work.latestCheckpoint.publicSummary, 600)}`);
  }
  if (work.latestCheckpoint?.nextStep) {
    lines.push(`Recorded next step: ${singleLine(work.latestCheckpoint.nextStep, 400)}`);
  }
  lines.push(
    "Use this checkpoint with the existing tool results and produce the final answer only when the requested outcome is supported.",
  );
  return lines.join("\n");
}

function singleLine(value: string, limit: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, limit);
}

function throwGuidedAbort(signal: AbortSignal): never {
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Guided Turn was aborted");
}
