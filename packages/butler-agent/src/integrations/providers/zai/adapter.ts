import { ZAI_MODELS } from "./catalog.ts";
import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const ZAI_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "zai",
  catalog: ZAI_MODELS,
  structuredDecisionTransport: "function_tool",
  async runPrompt(options) {
    return await (await import("./runtime.ts")).runZaiPrompt(options);
  },
  async runFunctionToolPrompt(options) {
    return await (await import("./runtime.ts")).runZaiFunctionToolPrompt(options);
  },
});
