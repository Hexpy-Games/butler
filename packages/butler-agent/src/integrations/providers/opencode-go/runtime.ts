import type { PromptOptions, PromptTextResult } from "../runtime-contracts.ts";
import type {
  ModelRoundRequest,
  ModelRoundResult,
} from "../../../agent/btcc/ports/model-round.ts";
import { runAnthropicModelRound } from "../anthropic/model-round.ts";
import { runAnthropicPromptText } from "../anthropic/runtime.ts";
import {
  openCodeGoApiShape,
  runHostedOpenAICompatibleModelRound,
  runHostedOpenAICompatiblePromptText,
} from "../shared/hosted-openai-compatible.ts";
import {
  runHostedResponsesModelRound,
  runHostedResponsesPromptText,
} from "../shared/hosted-responses-client.ts";
import { requireHostedRuntimeConfig } from "../shared/model-routing.ts";

export async function runOpenCodeGoPrompt(options: PromptOptions): Promise<PromptTextResult> {
  const config = requireHostedRuntimeConfig(options.model, "opencode-go");
  const shape = openCodeGoApiShape(config);
  const text = shape === "openai_chat_completions"
    ? await runHostedOpenAICompatiblePromptText(config, options)
    : shape === "openai_responses"
      ? (await runHostedResponsesPromptText(config, options)).text
      : await runAnthropicPromptText(config, options);
  return { text, model: config.modelRef, usage: null };
}

export async function runOpenCodeGoModelRound(
  request: ModelRoundRequest,
): Promise<ModelRoundResult> {
  const config = requireHostedRuntimeConfig(request.model, "opencode-go");
  const shape = openCodeGoApiShape(config);
  return shape === "openai_chat_completions"
    ? await runHostedOpenAICompatibleModelRound(config, request)
    : shape === "openai_responses"
      ? await runHostedResponsesModelRound(config, request)
      : await runAnthropicModelRound(config, request);
}
