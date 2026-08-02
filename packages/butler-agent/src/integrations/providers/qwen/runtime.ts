import type { PromptOptions, PromptTextResult } from "../runtime-contracts.ts";
import type {
  ModelRoundRequest,
  ModelRoundResult,
} from "../../../agent/btcc/ports/model-round.ts";
import {
  runHostedOpenAICompatibleModelRound,
  runHostedOpenAICompatiblePromptText,
} from "../shared/hosted-openai-compatible.ts";
import { requireHostedRuntimeConfig } from "../shared/model-routing.ts";

export async function runQwenPrompt(options: PromptOptions): Promise<PromptTextResult> {
  const config = requireHostedRuntimeConfig(options.model, "qwen");
  return {
    text: await runHostedOpenAICompatiblePromptText(config, options),
    model: config.modelRef,
    usage: null,
  };
}

export async function runQwenModelRound(request: ModelRoundRequest): Promise<ModelRoundResult> {
  return await runHostedOpenAICompatibleModelRound(
    requireHostedRuntimeConfig(request.model, "qwen"),
    request,
  );
}
