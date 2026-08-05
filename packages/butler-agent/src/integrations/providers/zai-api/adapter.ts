import { ZAI_API_MODELS } from "./catalog.ts";
import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const ZAI_API_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "zai-api",
  catalog: ZAI_API_MODELS,
  structuredDecisionTransport: "function_tool",
  async runPrompt(options) {
    return await (await import("./runtime.ts")).runZaiApiPrompt(options);
  },
  async runRound(request) {
    return await (await import("./runtime.ts")).runZaiApiModelRound(request);
  },
});
