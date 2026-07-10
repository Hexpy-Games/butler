import { KIMI_MODELS } from "./catalog.ts";
import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const KIMI_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "kimi",
  catalog: KIMI_MODELS,
  structuredDecisionTransport: "function_tool",
});
