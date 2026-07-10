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

export async function runKimiPrompt(options: PromptOptions): Promise<PromptTextResult> {
  const config = requireHostedRuntimeConfig(options.model, "kimi");
  return {
    text: await runHostedOpenAICompatiblePromptText(config, options),
    model: config.modelRef,
    usage: null,
  };
}
export async function runKimiFunctionToolPrompt(
  options: FunctionToolPromptOptions,
): Promise<string> {
  return await runHostedOpenAICompatibleFunctionToolPromptText(
    requireHostedRuntimeConfig(options.model, "kimi"),
    options,
  );
}
