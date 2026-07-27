import { resolveProviderAdapterDefinition } from "./registry.ts";
import type {
  FunctionToolPromptOptions,
  PromptTextResult,
} from "./runtime-contracts.ts";
import type { PromptCacheAwarePromptOptions } from "./prompt-cache-boundary.ts";
import { resolveEffectiveModelRef } from "./shared/model-routing.ts";
import { throwIfAborted } from "./shared/runtime-support.ts";

export async function runPromptTextWithUsage(
  options: PromptCacheAwarePromptOptions,
): Promise<PromptTextResult> {
  throwIfAborted(options.signal);
  const model = resolveEffectiveModelRef(options.model);
  const adapter = resolveProviderAdapterDefinition(model);
  return await adapter.runPrompt({ ...options, model });
}
export async function runPromptText(options: PromptCacheAwarePromptOptions): Promise<string> {
  return (await runPromptTextWithUsage(options)).text;
}

export async function runFunctionToolPromptText(
  options: FunctionToolPromptOptions,
): Promise<string> {
  throwIfAborted(options.signal);
  const model = resolveEffectiveModelRef(options.model);
  const adapter = resolveProviderAdapterDefinition(model);
  return await adapter.runFunctionToolPrompt({ ...options, model });
}
