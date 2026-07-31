import type {
  GuidedTurnAgent,
  GuidedTurnResult,
} from "../../btcc/index.ts";
import { digest } from "../../btcc/core/index.ts";
import type { DurableWorkService } from "../../btcc/durable-work/index.ts";
import { createGuidedEffectService } from "../../btcc/effects/index.ts";
import { createButlerToolExecutor } from "../../tools/butler-tools.ts";
import type {
  SqliteGuidedEffectJournal,
  SqliteGuidedToolJournal,
} from
  "../../adapters/index.ts";
import { projectLedgerProjectPath } from
  "../../../integrations/project-ledger/client.ts";
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
  hiddenNativeToolNamesForGuidedTurn,
  isReplaySafeTool,
  priorToolFailure,
  routeForUsedTools,
  selectedModelRef,
  uncertainPriorMutation,
  visibleToolDefinitions,
} from "./guided-turn-policy.ts";
import { createGuidedToolExecutionBoundary } from
  "./guided-tool-execution-boundary.ts";
import {
  createGuidedProjectLedgerEffectAdapter,
  isGuidedProjectLedgerEffectTool,
} from "./guided-project-ledger-effect.ts";
import { executeGuidedReadOnlyCommand } from "./guided-read-only-command.ts";
import { renderGuidedEffectContext } from "./guided-effect-context.ts";
import {
  createGuidedWorkspaceFileEffectAdapter,
  workspaceFileEffectTarget,
} from "./guided-workspace-file-effect.ts";
import {
  executeDurableWorkTool,
  isDurableWorkTool,
  renderDurableWorkContext,
} from "./durable-work-tools.ts";
import {
  backfillTurnToolResults,
  bindPresentedWorkForToolDispatch,
  safeBindOpenWork,
  safeImportOpenLegacyWork,
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
import { runGuidedPromptWithOperationalReport } from
  "./guided-operational-report.ts";

type PromptRunner = (options: FunctionToolPromptOptions) => Promise<string>;

export function createProductionGuidedTurnAgent(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath: string;
  contextDocuments: { resolve(contextRef: string): string };
  toolJournal: SqliteGuidedToolJournal;
  effectJournal: SqliteGuidedEffectJournal;
  durableWork: DurableWorkService;
  promptRunner?: PromptRunner;
  turnLeaseMs?: number;
  finalReportMs?: number;
}): GuidedTurnAgent {
  const promptRunner = input.promptRunner ?? runFunctionToolPromptText;
  return {
    async run({ turn, signal, progress }): Promise<GuidedTurnResult> {
      const leaseStartedAt = Date.now();
      const policy = guidedPolicy(turn);
      const workScope = workScopeForTurn(turn, policy.trackingMode);
      let initialWork = policy.trackingMode === "none"
        ? null
        : await safeLoadWorkContext(input.durableWork, workScope);
      if (!initialWork && policy.trackingMode === "local") {
        await safeImportOpenLegacyWork(input.durableWork, workScope);
        initialWork = await safeLoadWorkContext(input.durableWork, workScope);
      }
      if (initialWork) {
        const boundWork = await safeBoundWork(input.durableWork, turn.turnId);
        if (boundWork?.workId === initialWork.work.workId) {
          await backfillTurnToolResults(input, workScope);
          initialWork = await safeLoadWorkContext(input.durableWork, workScope);
        }
      }
      const presentedWorkId = initialWork?.work.workId;
      const authorizedTools = authorizedToolDefinitions(turn);
      const authorizedNames = new Set(authorizedTools.map((tool) => tool.name));
      const visibleTools = visibleToolDefinitions(authorizedTools, policy.accessMode);
      const visibleNames = new Set(visibleTools.map((tool) => tool.name));
      const describedToolIds = new Set<string>();
      const usedTools: string[] = [];
      let callIndex = 0;
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
        searchPlannerOriginalRequest: turn.originalMessage,
        workerModel: selectedModelRef(turn),
        searchPlannerModel: selectedModelRef(turn),
        currentToolNames: () => [...authorizedNames],
        hiddenNativeToolNames: hiddenNativeToolNamesForGuidedTurn(
          policy.accessMode === "full_access" && Boolean(policy.projectId),
        ),
        describedToolIds: () => [...describedToolIds],
        executionBoundary: createGuidedToolExecutionBoundary({
          durableWork: input.durableWork,
          workScope,
          effectService,
          accessMode: policy.accessMode,
          signal,
          executeReadOnlyCommand: (call) => executeGuidedReadOnlyCommand({
            args: call.args,
            butlerData: input.butlerData,
            workspacePath: policy.workspacePath,
            originalRequest: turn.originalMessage,
            signal: call.signal ?? signal,
          }),
          resolvePersistentEffect(call, executeRegistered) {
            if (call.name === "write_file") {
              const adapter = createGuidedWorkspaceFileEffectAdapter({
                workspacePath: policy.workspacePath,
                butlerData: input.butlerData,
                executeWriteFile: async () => executeRegistered(),
              });
              const normalizedInput = adapter.normalizeInput(call.args);
              return {
                target: workspaceFileEffectTarget(normalizedInput.path),
                input: normalizedInput,
                adapter,
              };
            }
            if (!isGuidedProjectLedgerEffectTool(call.name) || !policy.projectId) {
              return null;
            }
            const projectRoot = projectLedgerProjectPath({
              butlerHome: input.butlerHome,
              butlerData: input.butlerData,
              appMessageDbPath: input.appMessageDbPath,
              workspacePath: policy.workspacePath,
              projectId: policy.projectId,
            }, {});
            const effect = createGuidedProjectLedgerEffectAdapter({
              name: call.name,
              args: call.args,
              butlerData: input.butlerData,
              projectRoot,
              projectRef: policy.projectId,
            });
            return {
              target: effect.target,
              input: effect.normalizedInput,
              adapter: effect.adapter,
            };
          },
        }),
      });
      const promptOptions: FunctionToolPromptOptions = {
          prompt: renderGuidedPrompt(turn, {
            ...input,
            workContext: renderDurableWorkContext(initialWork),
            effectContext: initialWork
              ? renderGuidedEffectContext(
                  input.effectJournal.listForWork(initialWork.work.workId),
                )
              : "",
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
            const toolSignal = call.signal ?? signal;
            throwIfToolAborted(toolSignal);
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
            if (!isDurableWorkTool(call.name) && presentedWorkId) {
              await bindPresentedWorkForToolDispatch(
                input,
                workScope,
                presentedWorkId,
              );
            }
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
                    signal: toolSignal,
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
              const cancelled = signal.aborted || toolSignal.aborted;
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
        };
      const text = await runGuidedPromptWithOperationalReport({
        promptRunner,
        options: promptOptions,
        parentSignal: signal,
        leaseStartedAt,
        leaseMs: input.turnLeaseMs,
        finalReportMs: input.finalReportMs,
        async loadFacts() {
          const currentWork = await safeLoadWorkContext(input.durableWork, workScope) ??
            await safeBoundWork(input.durableWork, turn.turnId) ?? initialWork;
          const workId = currentWork && "work" in currentWork
            ? currentWork.work.workId
            : currentWork?.workId;
          return {
            originalRequest: turn.originalMessage,
            work: currentWork,
            toolCalls: input.toolJournal.list(turn.turnId),
            effects: workId ? input.effectJournal.listForWork(workId) : [],
          };
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

function throwIfToolAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Guided tool execution was cancelled");
}
