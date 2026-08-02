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
import { requireHostedRuntimeConfig } from "../shared/model-routing.ts";

export async function runOpenCodeGoPrompt(options: PromptOptions): Promise<PromptTextResult> {
  const config = requireHostedRuntimeConfig(options.model, "opencode-go");
  const text = openCodeGoApiShape(config) === "openai_chat_completions"
    ? await runHostedOpenAICompatiblePromptText(config, options)
    : await runAnthropicPromptText(config, options);
  return { text, model: config.modelRef, usage: null };
}

export async function runOpenCodeGoModelRound(
  request: ModelRoundRequest,
): Promise<ModelRoundResult> {
  const config = requireHostedRuntimeConfig(request.model, "opencode-go");
  return openCodeGoApiShape(config) === "openai_chat_completions"
    ? await runHostedOpenAICompatibleModelRound(config, request)
    : await runAnthropicModelRound(config, request);
}
