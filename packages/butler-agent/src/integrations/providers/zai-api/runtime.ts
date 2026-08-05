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

export async function runZaiApiPrompt(options: PromptOptions): Promise<PromptTextResult> {
  const config = requireHostedRuntimeConfig(options.model, "zai-api");
  return {
    text: await runHostedOpenAICompatiblePromptText(config, options),
    model: config.modelRef,
    usage: null,
  };
}

export async function runZaiApiModelRound(request: ModelRoundRequest): Promise<ModelRoundResult> {
  return await runHostedOpenAICompatibleModelRound(
    requireHostedRuntimeConfig(request.model, "zai-api"),
    request,
  );
}
