import type {
  GuidedTurnAgent,
  GuidedTurnResult,
} from "../../btcc/index.ts";
import { digest } from "../../btcc/core/index.ts";
import type { DurableWorkService } from "../../btcc/durable-work/index.ts";
import { createButlerToolExecutor } from "../../tools/butler-tools.ts";
import { WORK_TRACKING_TOOL_NAMES } from "../../tools/work-tracking/shared.ts";
import { PROJECT_LEDGER_MUTATION_TOOL_NAMES } from
  "../../tools/project-ledger/mutation-tools.ts";
import type { SqliteGuidedToolJournal } from
  "../../adapters/index.ts";
import { runFunctionToolPromptText } from
  "../../../integrations/providers/runtime.ts";
import type { FunctionToolPromptOptions } from
  "../../../integrations/providers/runtime-contracts.ts";
import {
  guidedInstructions,
  providerImageAttachments,
  renderGuidedPrompt,
} from "./guided-turn-prompt.ts";
import {
  authorizedToolDefinitions,
  effectiveToolNameForCall,
  guidedPolicy,
  isReplaySafeTool,
  priorToolFailure,
  routeForUsedTools,
  selectedModelRef,
  uncertainPriorMutation,
  visibleToolDefinitions,
} from "./guided-turn-policy.ts";
import {
  executeDurableWorkTool,
  isDurableWorkTool,
  renderDurableWorkContext,
} from "./durable-work-tools.ts";
import {
  backfillTurnToolResults,
  safeBindOpenWork,
  publishWorkCheckpoint,
  safeAttachToolResult,
  safeBoundWork,
  safeLoadWorkContext,
  workScopeForTurn,
} from "./guided-work-runtime.ts";
import {
  ordinaryToolError,
  publishOperation,
  rememberDescribedTools,
  safeJson,
  toolResultSucceeded,
  unauthorizedToolResult,
} from "./guided-tool-progress.ts";

type PromptRunner = (options: FunctionToolPromptOptions) => Promise<string>;

export function createProductionGuidedTurnAgent(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath: string;
  contextDocuments: { resolve(contextRef: string): string };
  toolJournal: SqliteGuidedToolJournal;
  durableWork: DurableWorkService;
  promptRunner?: PromptRunner;
}): GuidedTurnAgent {
  const promptRunner = input.promptRunner ?? runFunctionToolPromptText;
  return {
    async run({ turn, signal, progress }): Promise<GuidedTurnResult> {
      const policy = guidedPolicy(turn);
      const workScope = workScopeForTurn(turn, policy.trackingMode);
      const initialWork = policy.trackingMode === "none"
        ? null
        : await safeLoadWorkContext(input.durableWork, workScope);
      const authorizedTools = authorizedToolDefinitions(turn);
      const authorizedNames = new Set(authorizedTools.map((tool) => tool.name));
      const visibleTools = visibleToolDefinitions(authorizedTools, policy.accessMode);
      const visibleNames = new Set(visibleTools.map((tool) => tool.name));
      const describedToolIds = new Set<string>();
      const usedTools: string[] = [];
      let callIndex = 0;
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
        searchPlannerOriginalRequest: turn.originalMessage,
        workerModel: selectedModelRef(turn),
        searchPlannerModel: selectedModelRef(turn),
        currentToolNames: () => [...authorizedNames],
        hiddenNativeToolNames: [
          ...WORK_TRACKING_TOOL_NAMES,
          ...PROJECT_LEDGER_MUTATION_TOOL_NAMES,
        ],
        describedToolIds: () => [...describedToolIds],
      });
      const text = await promptRunner({
          prompt: renderGuidedPrompt(turn, {
            ...input,
            workContext: renderDurableWorkContext(initialWork),
          }),
          instructions: guidedInstructions(policy),
          model: selectedModelRef(turn),
          reasoningEffort: turn.modelSelection.reasoningEffort,
          cacheScope: `btcc-guided:${turn.sessionId}`,
          signal,
          butlerData: input.butlerData,
          attachments: providerImageAttachments(turn),
          tools: visibleTools,
          maxToolRounds: 12,
          async executeTool(call) {
            const effectiveToolName = effectiveToolNameForCall(call.name, call.args);
            const callId = digest([
              "btcc-guided-tool-call.v1",
              turn.turnId,
              String(callIndex++),
              call.name,
              call.rawArguments,
            ].join("\0"));
            usedTools.push(effectiveToolName);
            if (!visibleNames.has(call.name) || !authorizedNames.has(call.name)) {
              const denied = unauthorizedToolResult(effectiveToolName);
              const recorded = input.toolJournal.find(callId);
              if (!recorded) {
                input.toolJournal.start({
                  turnId: turn.turnId,
                  callId,
                  toolName: effectiveToolName,
                  rawArguments: call.rawArguments,
                  arguments: call.args,
                });
                input.toolJournal.finish({ callId, status: "completed", result: denied });
              }
              await publishOperation(progress, {
                turnId: turn.turnId,
                requestId: callId,
                toolName: effectiveToolName,
                status: "failed",
                resultJson: safeJson(recorded?.result ?? denied),
              });
              return recorded?.result ?? denied;
            }
            const recorded = input.toolJournal.find(callId);
            if (recorded?.status === "completed") {
              if (!isDurableWorkTool(call.name)) {
                await safeAttachToolResult(input, workScope, recorded.callId);
              }
              rememberDescribedTools(call.name, recorded.result, describedToolIds);
              await publishOperation(progress, {
                turnId: turn.turnId,
                requestId: callId,
                toolName: effectiveToolName,
                status: "started",
              });
              await publishOperation(progress, {
                turnId: turn.turnId,
                requestId: callId,
                toolName: effectiveToolName,
                status: toolResultSucceeded(recorded.result) ? "completed" : "failed",
                resultJson: safeJson(recorded.result),
              });
              return recorded.result;
            }
            if (recorded?.status === "failed" || recorded?.status === "cancelled") {
              await publishOperation(progress, {
                turnId: turn.turnId,
                requestId: callId,
                toolName: effectiveToolName,
                status: recorded.status === "cancelled" ? "cancelled" : "failed",
              });
              return priorToolFailure(recorded.status, effectiveToolName);
            }
            if (recorded?.status === "started" && !isReplaySafeTool(effectiveToolName)) {
              await publishOperation(progress, {
                turnId: turn.turnId,
                requestId: callId,
                toolName: effectiveToolName,
                status: "failed",
              });
              return uncertainPriorMutation(effectiveToolName);
            }
            input.toolJournal.start({
              turnId: turn.turnId,
              callId,
              toolName: effectiveToolName,
              rawArguments: call.rawArguments,
              arguments: call.args,
            });
            await publishOperation(progress, {
              turnId: turn.turnId,
              requestId: callId,
              toolName: effectiveToolName,
              status: "started",
            });
            try {
              if (isDurableWorkTool(call.name) && call.name !== "replace_work_plan") {
                await safeBindOpenWork(input.durableWork, workScope);
                await backfillTurnToolResults(input, workScope);
              }
              const result = isDurableWorkTool(call.name)
                ? await executeDurableWorkTool({
                    service: input.durableWork,
                    scope: workScope,
                    mutationCallId: callId,
                    name: call.name,
                    args: call.args,
                  })
                : await execute({
                    ...call,
                    signal: call.signal ?? signal,
                  });
              rememberDescribedTools(call.name, result, describedToolIds);
              input.toolJournal.finish({ callId, status: "completed", result });
              if (call.name === "replace_work_plan" && toolResultSucceeded(result)) {
                await backfillTurnToolResults(input, workScope);
              } else if (!isDurableWorkTool(call.name)) {
                await safeAttachToolResult(input, workScope, callId);
              }
              if (call.name === "record_work_checkpoint" && toolResultSucceeded(result)) {
                await publishWorkCheckpoint(progress, turn.turnId, input.durableWork);
              }
              await publishOperation(progress, {
                turnId: turn.turnId,
                requestId: callId,
                toolName: effectiveToolName,
                status: toolResultSucceeded(result) ? "completed" : "failed",
                resultJson: safeJson(result),
              });
              return result;
            } catch (error) {
              const cancelled = signal.aborted || call.signal?.aborted;
              if (!cancelled) {
                const result = ordinaryToolError(effectiveToolName, error);
                input.toolJournal.finish({ callId, status: "completed", result });
                if (!isDurableWorkTool(call.name)) {
                  await safeAttachToolResult(input, workScope, callId);
                }
                await publishOperation(progress, {
                  turnId: turn.turnId,
                  requestId: callId,
                  toolName: effectiveToolName,
                  status: "failed",
                  resultJson: safeJson(result),
                });
                return result;
              }
              input.toolJournal.finish({
                callId,
                status: "cancelled",
                errorCode: "cancelled",
              });
              await publishOperation(progress, {
                turnId: turn.turnId,
                requestId: callId,
                toolName: effectiveToolName,
                status: "cancelled",
              });
              throw error;
            }
          },
        });
      return {
        content: text,
        route: routeForUsedTools(
          usedTools,
          Boolean(await safeBoundWork(input.durableWork, turn.turnId)),
        ),
      };
    },
  };
}
