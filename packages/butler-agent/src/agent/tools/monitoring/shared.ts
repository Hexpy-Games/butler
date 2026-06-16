import { createConfiguredWebSearchProvider, type WebSearchProvider } from "../../../integrations/search/provider.ts";
import { readContextMonitor } from "../../../operations/metrics/context-monitor.ts";
import { readUsageMonitor } from "../../../operations/metrics/usage-monitor.ts";
import { readMemoryHealth } from "../../cognition/memory/quality.ts";
import { readToolOutputArtifactSlice } from "../../context/tool-output-budgeter.ts";
import { BUTLER_TOOLS, TOOL_CAPABILITY_METADATA } from "../registry.ts";
import type { ButlerToolDefinition, ToolCapabilityCategory, ToolCapabilityMetadata } from "../types.ts";

type ToolCall = { args: Record<string, unknown> };

interface ToolCapabilityView {
  name: string;
  description: string;
  category: ToolCapabilityCategory;
  enabled: boolean;
  disabled_reason: string | null;
  concurrency_safe: boolean;
  interrupt_behavior: ButlerToolDefinition["interruptBehavior"];
  transcript_visibility: ButlerToolDefinition["transcriptVisibility"];
  tags: string[];
  safety_notes: string[];
}

const DEFAULT_TOOL_CAPABILITY: ToolCapabilityMetadata = {
  category: "control",
  tags: [],
  safetyNotes: ["Use only when the tool schema matches the user's intent."],
};

export function createMonitoringToolHandlers(input: {
  butlerData: string;
  sessionId?: string;
  webSearchProvider?: WebSearchProvider;
}) {
  return {
    "get_context_monitor": async (call: ToolCall) => ({
      ok: true,
      ...readContextMonitor({
        butlerData: input.butlerData,
        sessionId: typeof call.args.session_id === "string" && call.args.session_id.trim()
          ? call.args.session_id.trim()
          : input.sessionId,
      }),
    }),
    "read_tool_output_artifact": async (call: ToolCall) => readToolOutputArtifactSlice({
      butlerData: input.butlerData,
      artifactId: typeof call.args.artifact_id === "string" && call.args.artifact_id.trim()
        ? call.args.artifact_id.trim()
        : undefined,
      path: typeof call.args.path === "string" && call.args.path.trim()
        ? call.args.path.trim()
        : undefined,
      stream:
        call.args.stream === "stdout" || call.args.stream === "stderr" || call.args.stream === "both"
          ? call.args.stream
          : undefined,
      offsetLines: typeof call.args.offset_lines === "number" ? call.args.offset_lines : undefined,
      limitLines: typeof call.args.limit_lines === "number" ? call.args.limit_lines : undefined,
      maxTokens: typeof call.args.max_tokens === "number" ? call.args.max_tokens : undefined,
    }),
    "get_usage_monitor": async (call: ToolCall) => {
      const sinceHours = typeof call.args.since_hours === "number" && call.args.since_hours > 0
        ? call.args.since_hours
        : null;
      return {
        ok: true,
        ...readUsageMonitor({
          butlerData: input.butlerData,
          sessionId: typeof call.args.session_id === "string" && call.args.session_id.trim()
            ? call.args.session_id.trim()
            : input.sessionId,
          sinceTs: sinceHours === null ? null : Date.now() - sinceHours * 60 * 60 * 1000,
        }),
      };
    },
    "list_tool_capabilities": async (call: ToolCall) => ({
      ok: true,
      capabilities: listToolCapabilities({
        butlerData: input.butlerData,
        webSearchProvider: input.webSearchProvider,
        category: toolCategory(call.args.category),
        includeDisabled: call.args.include_disabled !== false,
      }),
    }),
    "get_memory_health": async (_call: ToolCall) => ({
      ok: true,
      ...readMemoryHealth({
        butlerData: input.butlerData,
      }),
    }),
  };
}

function toolCategory(value: unknown): ToolCapabilityCategory | undefined {
  if (
    value === "search" ||
    value === "data" ||
    value === "command" ||
    value === "work" ||
    value === "monitoring" ||
    value === "automation" ||
    value === "todo" ||
    value === "memory" ||
    value === "project" ||
    value === "skill" ||
    value === "mcp" ||
    value === "dispatch" ||
    value === "control"
  ) return value;
  return undefined;
}

function capabilityAvailability(tool: ButlerToolDefinition, input: {
  butlerData: string;
  webSearchProvider?: WebSearchProvider;
}): { enabled: boolean; disabled_reason: string | null } {
  if (tool.name !== "web_search") return { enabled: true, disabled_reason: null };
  const provider = createConfiguredWebSearchProvider({
    butlerData: input.butlerData,
    provider: input.webSearchProvider,
  });
  if (provider.id === "disabled") {
    return {
      enabled: false,
      disabled_reason: "web search provider is disabled by configuration",
    };
  }
  return { enabled: true, disabled_reason: null };
}

function listToolCapabilities(input: {
  butlerData: string;
  webSearchProvider?: WebSearchProvider;
  category?: ToolCapabilityCategory;
  includeDisabled?: boolean;
}): ToolCapabilityView[] {
  const includeDisabled = input.includeDisabled !== false;
  return BUTLER_TOOLS
    .map((tool) => {
      const metadata = TOOL_CAPABILITY_METADATA[tool.name] ?? DEFAULT_TOOL_CAPABILITY;
      const availability = capabilityAvailability(tool, input);
      return {
        name: tool.name,
        description: tool.description,
        category: metadata.category,
        enabled: availability.enabled,
        disabled_reason: availability.disabled_reason,
        concurrency_safe: tool.concurrencySafe,
        interrupt_behavior: tool.interruptBehavior,
        transcript_visibility: tool.transcriptVisibility,
        tags: metadata.tags,
        safety_notes: metadata.safetyNotes,
      };
    })
    .filter((capability) => !input.category || capability.category === input.category)
    .filter((capability) => includeDisabled || capability.enabled)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}
