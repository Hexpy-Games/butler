import { OPENAI_MODELS } from "./catalog.ts";
import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const OPENAI_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "openai",
  catalog: OPENAI_MODELS,
  structuredDecisionTransport: "json_schema",
});
