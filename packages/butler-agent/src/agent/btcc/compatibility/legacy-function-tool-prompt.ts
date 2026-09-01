import {
  runBtccAgentLoop,
  type BtccAgentLoopInput,
} from "../agent-loop/index.ts";
import type { ModelRoundPort } from "../ports/model-round.ts";
import type { FunctionToolPromptOptions } from "../../../integrations/providers/runtime-contracts.ts";
import {
  resolveEffectiveModelRef,
  resolveLocalModelConfig,
} from "../../../integrations/providers/shared/model-routing.ts";
import {
  finalEnvelopeRetryInstructions,
  finalNoToolInstructions,
} from "../../../integrations/providers/shared/tools.ts";
import {
  extractLocalFinalEnvelopeText,
  localChatUrl,
  localFunctionToolContractRepairPrompt,
} from "../../../integrations/providers/local/protocol.ts";
import { firstLocalAssistantMessage } from "../../../integrations/providers/local/client.ts";
import {
  providerEmptyResponseError,
  safeEndpointLabel,
} from "../../../integrations/providers/provider-errors.ts";
import { throwIfAborted } from "../../../integrations/providers/shared/runtime-support.ts";
import { createRoundToolSurfaceSnapshot } from
  "../agent-loop/round-tool-surface.ts";

/**
 * Compatibility boundary for callers that still provide the pre-BTCC tool
 * prompt options. The injected port performs one provider round at a time;
 * BTCC remains the only owner of semantic looping and tool execution.
 */
export async function runLegacyFunctionToolPromptText(
  options: FunctionToolPromptOptions,
  modelRound: ModelRoundPort,
): Promise<string> {
  throwIfAborted(options.signal);
  const model = resolveEffectiveModelRef(options.model);
  const localModel = model.startsWith("local/");
  const localConfig = localModel ? resolveLocalModelConfig(model) : null;
  let requiredToolRepairNames: Set<string> | null = null;
  let textToolRepairAttempted = false;
  const resolveTools = () => {
    const dynamicTools = options.dynamicTools?.();
    const activeTools = dynamicTools && dynamicTools.length > 0 ? dynamicTools : options.tools;
    if (!requiredToolRepairNames || requiredToolRepairNames.size === 0) {
      return createRoundToolSurfaceSnapshot(activeTools);
    }
    const narrowed = activeTools.filter((tool) => requiredToolRepairNames!.has(tool.name));
    return createRoundToolSurfaceSnapshot(narrowed.length > 0 ? narrowed : activeTools);
  };
  const finalSynthesis = {
    instructions: finalNoToolInstructions(options.instructions),
    maxAttempts: localModel ? 2 : 1,
    ...(localModel
      ? {
          retryInstructions: finalEnvelopeRetryInstructions(),
          includeInstructionsInMessages: true,
          triggerAfterToolCandidate: true,
          triggerAfterToolEmpty: true,
          acceptCandidate: ({ response }) => Boolean(localFinalEnvelopeText(response)),
          acceptText: ({ response }) => localFinalEnvelopeText(response),
          propagateFailure: true,
          onExhausted: () => {
            const config = localConfig!;
            throw providerEmptyResponseError({
              provider: "local",
              api: "chat_completions",
              endpoint: safeEndpointLabel(localChatUrl(config)),
              model: config.model_id,
              local: true,
            });
          },
        }
      : {}),
    onFailure: (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      options.log?.(`final no-tool synthesis failed; using safe fallback: ${message}`);
    },
  } satisfies BtccAgentLoopInput["finalSynthesis"];
  const result = await runBtccAgentLoop({
    prompt: options.prompt,
    model,
    instructions: options.instructions,
    reasoningEffort: options.reasoningEffort,
    cacheScope: options.cacheScope,
    signal: options.signal,
    attachments: options.attachments,
    butlerData: options.butlerData,
    usageAttribution: options.usageAttribution,
    onProviderStreamEvent: options.onProviderStreamEvent,
    onProviderResponseIdentity: options.onProviderResponseIdentity,
    providerRetryAttempts: options.providerRetryAttempts,
    toolChoice: options.toolChoice,
    tools: options.tools,
    resolveTools,
    resolveToolChoice: () => requiredToolRepairNames ? "required" : options.toolChoice ?? "auto",
    modelRound,
    onAssistantTextBeforeTools: async ({ text, toolCalls }) => {
      if (localModel && toolCalls.every((call) => call.origin !== "text")) {
        requiredToolRepairNames = null;
      }
      await options.onAssistantTextBeforeTools?.({
        text,
        toolCalls: toolCalls.map((call) => ({
          name: call.name,
          args: call.arguments,
        })),
      });
    },
    onTextToolCalls: localModel
      ? ({ names }) => {
          if (textToolRepairAttempted) {
            return {
              status: "fail",
              error: new Error("Local model failed to use the structured tool-call channel after required repair"),
            };
          }
          textToolRepairAttempted = true;
          requiredToolRepairNames = new Set(names);
          options.log?.("local model wrote a tool call as visible text; requesting required structured tool-call repair");
          return {
            status: "continue",
            observation: localFunctionToolContractRepairPrompt(),
          };
        }
      : undefined,
    executeTool: async (call) => await options.executeTool({
      name: call.name,
      args: call.arguments,
      rawArguments: call.rawArguments,
      providerCallId: call.id,
      signal: call.signal,
    }),
    finalTextFromToolResult: options.finalTextFromToolResult
      ? ({ toolCall, toolResult }) => toolResult.ok
        ? options.finalTextFromToolResult!({
            name: toolCall.name,
            args: toolCall.arguments,
            output: toolResult.output,
          })
        : null
      : undefined,
    reviewFinalCandidate: options.reviewFinalCandidate
      ? async ({ text, iteration }) => await options.reviewFinalCandidate!({
          text,
          roundIndex: iteration,
        })
      : undefined,
    finalSynthesis,
  });
  if (!result.finalText.trim()) throw new Error("Runtime finished without a text result");
  return result.finalText;
}

function localFinalEnvelopeText(
  response: Awaited<ReturnType<ModelRoundPort["runRound"]>>,
): string {
  const raw = response.raw && typeof response.raw === "object"
    ? firstLocalAssistantMessage(response.raw as Record<string, any>)
    : response.assistantMessage?.providerData;
  return raw && typeof raw === "object"
    ? extractLocalFinalEnvelopeText(raw)
    : "";
}
