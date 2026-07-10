import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const LOCAL_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "local",
  catalog: [],
  structuredDecisionTransport: null,
});

