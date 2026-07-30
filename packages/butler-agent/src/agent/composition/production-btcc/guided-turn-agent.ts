import type {
  GuidedTurnAgent,
  GuidedTurnResult,
} from "../../btcc/index.ts";
import { digest } from "../../btcc/core/index.ts";
import { createButlerToolExecutor } from "../../tools/butler-tools.ts";
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
  publicToolTitle,
  routeForUsedTools,
  selectedModelRef,
  uncertainPriorMutation,
  visibleToolDefinitions,
} from "./guided-turn-policy.ts";

type PromptRunner = (options: FunctionToolPromptOptions) => Promise<string>;

export function createProductionGuidedTurnAgent(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath: string;
  contextDocuments: { resolve(contextRef: string): string };
  toolJournal: SqliteGuidedToolJournal;
  promptRunner?: PromptRunner;
}): GuidedTurnAgent {
  const promptRunner = input.promptRunner ?? runFunctionToolPromptText;
  return {
    async run({ turn, signal, progress }): Promise<GuidedTurnResult> {
      const policy = guidedPolicy(turn);
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
        describedToolIds: () => [...describedToolIds],
      });
      const text = await promptRunner({
          prompt: renderGuidedPrompt(turn, input),
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
            if (!visibleNames.has(call.name) || !authorizedNames.has(call.name)) {
              throw new Error(`Tool is not authorized for this turn: ${call.name}`);
            }
            const effectiveToolName = effectiveToolNameForCall(call.name, call.args);
            const callId = digest([
              "btcc-guided-tool-call.v1",
              turn.turnId,
              String(callIndex++),
              call.name,
              call.rawArguments,
            ].join("\0"));
            usedTools.push(effectiveToolName);
            const recorded = input.toolJournal.find(callId);
            if (recorded?.status === "completed") {
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
              const result = await execute({
                ...call,
                signal: call.signal ?? signal,
              });
              rememberDescribedTools(call.name, result, describedToolIds);
              input.toolJournal.finish({ callId, status: "completed", result });
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
              input.toolJournal.finish({
                callId,
                status: cancelled ? "cancelled" : "failed",
                errorCode: cancelled ? "cancelled" : "tool_error",
              });
              await publishOperation(progress, {
                turnId: turn.turnId,
                requestId: callId,
                toolName: effectiveToolName,
                status: cancelled ? "cancelled" : "failed",
              });
              throw error;
            }
          },
        });
      return {
        content: text,
        route: routeForUsedTools(usedTools),
      };
    },
  };
}

function rememberDescribedTools(
  toolName: string,
  result: unknown,
  described: Set<string>,
): void {
  if (toolName !== "tool_describe" || !result || typeof result !== "object") return;
  const descriptions = (result as { descriptions?: unknown }).descriptions;
  if (!Array.isArray(descriptions)) return;
  for (const value of descriptions) {
    if (!value || typeof value !== "object") continue;
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id) described.add(id);
  }
}

async function publishOperation(
  progress: Parameters<GuidedTurnAgent["run"]>[0]["progress"],
  input: {
    turnId: string;
    requestId: string;
    toolName: string;
    status: "started" | "completed" | "failed" | "cancelled";
    resultJson?: string;
  },
): Promise<void> {
  if (!progress?.operationChanged) return;
  try {
    await progress.operationChanged({
      turnId: input.turnId,
      semanticState: "admitted",
      activityId: `guided-tools:${input.turnId}`,
      requestId: input.requestId,
      publicTitle: publicToolTitle(input.toolName),
      capabilityRef: input.toolName,
      status: input.status,
      ...(input.resultJson
        ? {
            resultRef: {
              id: digest(`btcc-guided-tool-result.v1\0${digest(input.resultJson)}`),
              sha256: digest(input.resultJson),
            },
            byteLength: Buffer.byteLength(input.resultJson),
          }
        : {}),
    });
  } catch {
    // Public progress cannot veto tool execution.
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ unavailable: true });
  }
}

function toolResultSucceeded(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return true;
  const record = result as Record<string, unknown>;
  if (record.ok === false || record.timed_out === true) return false;
  return typeof record.exit_code !== "number" || record.exit_code === 0;
}
