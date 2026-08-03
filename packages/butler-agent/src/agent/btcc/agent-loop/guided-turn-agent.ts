import type { DurableWorkService } from "../work/index.ts";
import type {
  BtccAgentLoopInput,
} from "./contracts.ts";
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
import { GuidedOperationalLease } from "./guided-operational-lease.ts";
import { createGuidedActivityProjection } from
  "../projection/index.ts";
import { isDurableWorkCompletionValidationCurrent } from
  "./durable-work-context.ts";
import { createGuidedPersistentEffectResolver } from
  "./guided-persistent-effect-resolution.ts";

export function createProductionGuidedTurnAgent(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath: string;
  contextDocuments: { resolve(contextRef: string): string };
  toolJournal: SqliteGuidedToolJournal;
  effectJournal: SqliteGuidedEffectJournal;
  durableWork: DurableWorkService;
  modelRound?: ModelRoundPort;
  turnLeaseMs?: number;
  absoluteTurnLeaseMs?: number;
  finalReportMs?: number;
}): BtccAgentLoop {
  const projectLedgerResolver = new ActiveProjectLedgerResolver();
  return {
    async run({ turn, signal, progress }): Promise<BtccAgentLoopResult> {
      const leaseStartedAt = Date.now();
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
      const operationalLease = new GuidedOperationalLease({
        startedAt: leaseStartedAt,
        leaseMs: input.turnLeaseMs,
        absoluteLeaseMs: input.absoluteTurnLeaseMs,
        finalReportMs: input.finalReportMs,
        managedInitially: initialWorkBound,
      });
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
          onAppliedEffect: () => operationalLease.recordDurableProgress(),
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
      const toolCalls = createGuidedToolCallExecutor({
        turn,
        signal,
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
        onDurableProgress: () => operationalLease.recordDurableProgress(),
      });
      const modelRound = input.modelRound ?? createProviderModelRoundPort();
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
        instructions: guidedInstructions(policy),
        progress,
        model: selectedModelRef(turn),
        reasoningEffort: turn.modelSelection.reasoningEffort,
        cacheScope: `btcc-guided:${turn.sessionId}`,
        signal,
        butlerData: input.butlerData,
        attachments: providerImageAttachments(turn),
        tools: visibleTools,
        maxIterations: Number.POSITIVE_INFINITY,
        modelRound,
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
        leaseStartedAt,
        originalRequest: turn.originalMessage,
        leaseMs: input.turnLeaseMs,
        finalReportMs: input.finalReportMs,
        operationalLease,
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
          };
        },
      });
      const finalWork = await safeBoundWork(input.durableWork, turn.turnId);
      await activity.publishFinal(text, {
        managed: Boolean(finalWork),
        completed: finalWork?.status === "completed",
        completionValidated: finalWork
          ? isDurableWorkCompletionValidationCurrent(finalWork)
          : false,
        currentStage: finalWork?.currentStage,
      });
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
