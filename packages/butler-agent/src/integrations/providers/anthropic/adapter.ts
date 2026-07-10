import { ANTHROPIC_MODELS } from "./catalog.ts";
import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const ANTHROPIC_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "anthropic",
  catalog: ANTHROPIC_MODELS,
  structuredDecisionTransport: "function_tool",
});
