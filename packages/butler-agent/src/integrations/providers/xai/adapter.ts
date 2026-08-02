import { XAI_MODELS } from "./catalog.ts";
import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const XAI_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "xai",
  catalog: XAI_MODELS,
  structuredDecisionTransport: "function_tool",
  async runPrompt(options) {
    return await (await import("./runtime.ts")).runXaiPrompt(options);
  },
  async runRound(request) {
    return await (await import("./runtime.ts")).runXaiModelRound(request);
  },
});
