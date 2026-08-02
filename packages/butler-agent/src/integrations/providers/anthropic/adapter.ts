import { ANTHROPIC_MODELS } from "./catalog.ts";
import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const ANTHROPIC_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "anthropic",
  catalog: ANTHROPIC_MODELS,
  structuredDecisionTransport: "function_tool",
  async runPrompt(options) {
    const [{ requireHostedRuntimeConfig }, { runAnthropicPromptText }] = await Promise.all([
      import("../shared/model-routing.ts"),
      import("./runtime.ts"),
    ]);
    const config = requireHostedRuntimeConfig(options.model, "anthropic");
    return {
      text: await runAnthropicPromptText(config, options),
      model: config.modelRef,
      usage: null,
    };
  },
  async runRound(request) {
    const [{ requireHostedRuntimeConfig }, { runAnthropicModelRound }] =
      await Promise.all([import("../shared/model-routing.ts"), import("./model-round.ts")]);
    return await runAnthropicModelRound(
      requireHostedRuntimeConfig(request.model, "anthropic"),
      request,
    );
  },
});
