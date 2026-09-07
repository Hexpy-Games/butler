import type { ModelProviderAdapter } from "../../../../integrations/providers/contracts.ts";
import { runPromptText } from "../../../../integrations/providers/runtime.ts";

/** Tool-less product text generation; never creates an agent session or execution loop. */
export function createAppTextProvider(butlerData: string): Pick<ModelProviderAdapter, "invoke"> {
  return { async invoke(input) {
    const purpose = String(input.metadata?.purpose ?? "app_text");
    const output = input.metadata?.requestedOutputTokens;
    const text = await runPromptText({ model: input.model, butlerData,
      instructions: input.systemPrompt,
      prompt: input.messages.map(message => `${message.role}: ${message.content}`).join("\n\n"),
      responseFormat: input.responseFormat,
      reasoningEffort: input.reasoning?.effort,
      signal: input.signal, cacheScope: purpose, providerRetryAttempts: 1,
      ...(typeof output === "number" ? { usageAttribution: { phase: purpose, requestedOutputTokens: output } } : {}),
    });
    return { text };
  } };
}
