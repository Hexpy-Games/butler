import { OPENCODE_GO_MODELS } from "./catalog.ts";
import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const OPENCODE_GO_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "opencode-go",
  catalog: OPENCODE_GO_MODELS,
  structuredDecisionTransport: "function_tool",
  async runPrompt(options) {
    return await (await import("./runtime.ts")).runOpenCodeGoPrompt(options);
  },
  async runFunctionToolPrompt(options) {
    return await (await import("./runtime.ts")).runOpenCodeGoFunctionToolPrompt(options);
  },
});
