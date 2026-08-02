import { resolveProviderAdapterDefinition } from "./registry.ts";
import type {
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
} from "../../agent/btcc/ports/model-round.ts";
import type {
  FunctionToolPromptOptions,
  PromptTextResult,
} from "./runtime-contracts.ts";
import { runLegacyFunctionToolPromptText } from "../../agent/btcc/compatibility/legacy-function-tool-prompt.ts";
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

/**
 * Legacy test/secondary-caller facade. The semantic loop is BTCC-owned; this
 * facade only translates the older options shape to the one-round port.
 * Guided Turn production composition does not call this function.
 */
export async function runFunctionToolPromptText(
  options: FunctionToolPromptOptions,
): Promise<string> {
  return await runLegacyFunctionToolPromptText(options, createProviderModelRoundPort());
}

export async function runModelRound(
  request: ModelRoundRequest,
): Promise<ModelRoundResult> {
  throwIfAborted(request.signal);
  const model = resolveEffectiveModelRef(request.model);
  const adapter = resolveProviderAdapterDefinition(model);
  return await adapter.runRound({ ...request, model });
}

export function createProviderModelRoundPort(): ModelRoundPort {
  return { runRound: runModelRound };
}
