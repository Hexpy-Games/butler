import type {
  FunctionToolPromptOptions,
  PromptOptions,
  PromptTextResult,
} from "../runtime-contracts.ts";
import {
  runHostedOpenAICompatibleFunctionToolPromptText,
  runHostedOpenAICompatiblePromptText,
} from "../shared/hosted-openai-compatible.ts";
import { requireHostedRuntimeConfig } from "../shared/model-routing.ts";

export async function runZaiPrompt(options: PromptOptions): Promise<PromptTextResult> {
  const config = requireHostedRuntimeConfig(options.model, "zai");
  return {
    text: await runHostedOpenAICompatiblePromptText(config, options),
    model: config.modelRef,
    usage: null,
  };
}
export async function runZaiFunctionToolPrompt(
  options: FunctionToolPromptOptions,
): Promise<string> {
  return await runHostedOpenAICompatibleFunctionToolPromptText(
    requireHostedRuntimeConfig(options.model, "zai"),
    options,
  );
}
