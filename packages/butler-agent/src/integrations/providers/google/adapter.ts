import { GOOGLE_MODELS } from "./catalog.ts";
import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const GOOGLE_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "google",
  catalog: GOOGLE_MODELS,
  structuredDecisionTransport: "function_tool",
});
