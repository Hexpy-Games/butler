import { createConfiguredWebSearchProvider, type WebSearchProvider } from "../../integrations/search/provider.ts";
import type { ButlerToolDefinition } from "./types.ts";

export interface NativeToolAvailabilityInput {
  butlerData: string;
  webSearchProvider?: WebSearchProvider;
}

export function nativeToolAvailability(
  tool: ButlerToolDefinition,
  input: NativeToolAvailabilityInput,
): { enabled: boolean; disabledReason: string | null } {
  if (tool.name !== "web_search") return { enabled: true, disabledReason: null };
  const provider = createConfiguredWebSearchProvider({
    butlerData: input.butlerData,
    provider: input.webSearchProvider,
  });
  if (provider.id === "disabled") {
    return {
      enabled: false,
      disabledReason: "web search provider is disabled by configuration",
    };
  }
  return { enabled: true, disabledReason: null };
}
