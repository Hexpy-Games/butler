import type {
  FunctionToolPromptOptions,
  PromptOptions,
  PromptTextResult,
} from "../runtime-contracts.ts";
import {
  runAnthropicFunctionToolPromptText,
  runAnthropicPromptText,
} from "../anthropic/runtime.ts";
import {
  openCodeGoApiShape,
  runHostedOpenAICompatibleFunctionToolPromptText,
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
export async function runOpenCodeGoFunctionToolPrompt(
  options: FunctionToolPromptOptions,
): Promise<string> {
  const config = requireHostedRuntimeConfig(options.model, "opencode-go");
  return openCodeGoApiShape(config) === "openai_chat_completions"
    ? await runHostedOpenAICompatibleFunctionToolPromptText(config, options)
    : await runAnthropicFunctionToolPromptText(config, options);
}
