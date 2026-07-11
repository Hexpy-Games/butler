import { QWEN_MODELS } from "./catalog.ts";
import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const QWEN_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "qwen",
  catalog: QWEN_MODELS,
  structuredDecisionTransport: "function_tool",
  async runPrompt(options) {
    return await (await import("./runtime.ts")).runQwenPrompt(options);
  },
  async runFunctionToolPrompt(options) {
    return await (await import("./runtime.ts")).runQwenFunctionToolPrompt(options);
  },
});
