import { KIMI_MODELS } from "./catalog.ts";
import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const KIMI_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "kimi",
  catalog: KIMI_MODELS,
  structuredDecisionTransport: "function_tool",
  async runPrompt(options) {
    return await (await import("./runtime.ts")).runKimiPrompt(options);
  },
  async runRound(request) {
    return await (await import("./runtime.ts")).runKimiModelRound(request);
  },
});
