import { ZAI_MODELS } from "./catalog.ts";
import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const ZAI_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "zai",
  catalog: ZAI_MODELS,
  structuredDecisionTransport: "function_tool",
  async resolveVisualCapability(input) {
    return await (await import("./visual-capability.ts"))
      .resolveZaiMcpVisionCatalogEntry(input);
  },
  async runPrompt(options) {
    return await (await import("./runtime.ts")).runZaiPrompt(options);
  },
  async runRound(request) {
    return await (await import("./runtime.ts")).runZaiModelRound(request);
  },
});
