import type { PromptOptions, PromptTextResult } from "../runtime-contracts.ts";
import type {
  ModelRoundRequest,
  ModelRoundResult,
} from "../../../agent/btcc/ports/model-round.ts";
import {
  runHostedOpenAICompatibleModelRound,
  runHostedOpenAICompatiblePromptText,
} from "../shared/hosted-openai-compatible.ts";
import {
  runHostedResponsesModelRound,
  runHostedResponsesPromptText,
} from "../shared/hosted-responses-client.ts";
import { requireHostedRuntimeConfig } from "../shared/model-routing.ts";

export async function runXaiPrompt(options: PromptOptions): Promise<PromptTextResult> {
  const config = requireHostedRuntimeConfig(options.model, "xai");
  if (config.apiShape === "openai_responses") {
    return await runHostedResponsesPromptText(config, options);
  }
  return {
    text: await runHostedOpenAICompatiblePromptText(config, options),
    model: config.modelRef,
    usage: null,
  };
}

export async function runXaiModelRound(request: ModelRoundRequest): Promise<ModelRoundResult> {
  const config = requireHostedRuntimeConfig(request.model, "xai");
  return config.apiShape === "openai_responses"
    ? await runHostedResponsesModelRound(config, request)
    : await runHostedOpenAICompatibleModelRound(config, request);
}
