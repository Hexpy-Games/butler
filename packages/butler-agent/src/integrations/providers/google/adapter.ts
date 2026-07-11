import { GOOGLE_MODELS } from "./catalog.ts";
import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const GOOGLE_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "google",
  catalog: GOOGLE_MODELS,
  structuredDecisionTransport: "function_tool",
  async runPrompt(options) {
    const [{ requireHostedRuntimeConfig }, { runGeminiPromptText }] = await Promise.all([
      import("../shared/model-routing.ts"),
      import("./runtime.ts"),
    ]);
    const config = requireHostedRuntimeConfig(options.model, "google");
    return {
      text: await runGeminiPromptText(config, options),
      model: config.modelRef,
      usage: null,
    };
  },
  async runFunctionToolPrompt(options) {
    const [{ requireHostedRuntimeConfig }, { runGeminiFunctionToolPromptText }] =
      await Promise.all([import("../shared/model-routing.ts"), import("./runtime.ts")]);
    return await runGeminiFunctionToolPromptText(
      requireHostedRuntimeConfig(options.model, "google"),
      options,
    );
  },
});
