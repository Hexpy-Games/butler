import type {
  BenchmarkAgent,
  BenchmarkTrack,
  EffectiveAgentConfig,
} from "./contracts.ts";
import { sanitizeIdentifier } from "./identifiers.ts";

export interface TrackConfigurationInput {
  controlledModel: string;
  controlledReasoning?: string;
}

/** Resolve the product-facing configuration recorded on each plan arm. */
export function effectiveAgentConfig(
  agent: BenchmarkAgent,
  track: BenchmarkTrack,
  input: TrackConfigurationInput,
): EffectiveAgentConfig {
  if (track === "controlled") {
    const model = sanitizeIdentifier(input.controlledModel);
    if (!model) throw new Error("controlledModel must be a safe non-empty model identifier");
    const reasoning = sanitizeIdentifier(input.controlledReasoning ?? "medium");
    if (!reasoning) throw new Error("controlledReasoning must be a safe identifier");
    if (agent === "butler") {
      // The Electron harness accepts a full-access product configuration and
      // applies the requested model/reasoning. It does not expose a supported
      // tool/memory introspection surface, so keep those dimensions honest.
      return {
        model,
        reasoning,
        permissions: "benchmark-workspace-full-source-read-only",
        tools: ["product-default"],
        memoryEnabled: null,
        skillsEnabled: null,
        pluginsEnabled: null,
        mcpEnabled: null,
        provider: null,
        variant: null,
      };
    }
    if (agent === "hermes") {
      return {
        model,
        reasoning,
        permissions: "benchmark-workspace-full-source-read-only",
        tools: ["filesystem", "web"],
        memoryEnabled: false,
        skillsEnabled: false,
        pluginsEnabled: false,
        mcpEnabled: false,
        provider: model.startsWith("openai/") ? "openai-codex" : null,
        variant: null,
      };
    }
    return {
      model,
      reasoning,
      permissions: "benchmark-workspace-full-source-read-only",
      tools: ["filesystem", "web"],
      memoryEnabled: false,
      skillsEnabled: false,
      pluginsEnabled: false,
      mcpEnabled: false,
      provider: null,
      variant: reasoning,
    };
  }
  return {
    model: null,
    reasoning: null,
    permissions: "product-recommended-default",
    tools: agent === "butler" ? ["product-default"] : ["filesystem", "web", "terminal"],
    memoryEnabled: null,
    skillsEnabled: null,
    pluginsEnabled: null,
    mcpEnabled: null,
    provider: null,
    variant: null,
  };
}
