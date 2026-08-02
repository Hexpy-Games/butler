import { OPENAI_MODELS } from "./catalog.ts";
import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const OPENAI_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "openai",
  catalog: OPENAI_MODELS,
  structuredDecisionTransport: "json_schema",
  async runPrompt(options) {
    const [{ openAIAuthOverrideForHosted, resolveHostedRuntimeConfig }, { runOpenAIPromptWithUsage }] =
      await Promise.all([import("../shared/model-routing.ts"), import("./runtime.ts")]);
    const config = resolveHostedRuntimeConfig(options.model);
    const hostedConfig = config?.providerId === "openai" ? config : null;
    return await runOpenAIPromptWithUsage(
      options,
      hostedConfig ? await openAIAuthOverrideForHosted(hostedConfig) : undefined,
      hostedConfig?.modelId,
    );
  },
  async runRound(request) {
    const [{ openAIAuthOverrideForHosted, resolveHostedRuntimeConfig }, { runOpenAIModelRound }] =
      await Promise.all([import("../shared/model-routing.ts"), import("./model-round.ts")]);
    const config = resolveHostedRuntimeConfig(request.model);
    const hostedConfig = config?.providerId === "openai" ? config : null;
    return await runOpenAIModelRound(
      request,
      hostedConfig ? await openAIAuthOverrideForHosted(hostedConfig) : undefined,
      hostedConfig?.modelId,
    );
  },
});
