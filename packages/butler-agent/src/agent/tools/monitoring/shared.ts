import type { WebSearchProvider } from "../../../integrations/search/provider.ts";
import { readContextMonitor } from "../../../operations/metrics/context-monitor.ts";
import { readUsageMonitor } from "../../../operations/metrics/usage-monitor.ts";
import { readMemoryHealth } from "../../cognition/memory/quality.ts";
import { readToolOutputArtifactSlice } from "../../context/tool-output-budgeter.ts";
import { BUTLER_TOOLS, TOOL_CAPABILITY_METADATA } from "../registry.ts";
import { nativeToolAvailability } from "../tool-availability.ts";
import type { ButlerToolDefinition, ToolCapabilityCategory, ToolCapabilityMetadata } from "../types.ts";

type ToolCall = { args: Record<string, unknown> };

interface ToolCapabilityView {
  name: string;
  description: string;
  category: ToolCapabilityCategory;
  enabled: boolean;
  disabled_reason: string | null;
  current_turn_selected: boolean | null;
  current_turn_callable: boolean | null;
  omitted_by_profile: boolean | null;
  availability_scope: "current_turn" | "registry";
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

const TOOL_CAPABILITY_CATEGORIES = [
  "search",
  "data",
  "command",
  "file",
  "work",
  "monitoring",
  "automation",
  "todo",
  "memory",
  "project",
  "skill",
  "mcp",
  "dispatch",
  "control",
] as const satisfies readonly ToolCapabilityCategory[];

export function createMonitoringToolHandlers(input: {
  butlerData: string;
  sessionId?: string;
  webSearchProvider?: WebSearchProvider;
  currentToolNames?: readonly string[] | (() => readonly string[]);
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
    "list_tool_capabilities": async (call: ToolCall) => {
      const category = parseToolCategory(call.args.category);
      if (category.invalid) {
        return {
          ok: false,
          error: {
            code: "invalid_tool_category",
            message: `Unknown tool capability category: ${category.invalid}`,
          },
          invalid_category: category.invalid,
          valid_categories: [...TOOL_CAPABILITY_CATEGORIES],
          capabilities: [],
        };
      }
      const currentToolNames = resolveCurrentToolNames(input.currentToolNames);
      return {
        ok: true,
        current_turn_surface_known: currentToolNames !== null,
        valid_categories: [...TOOL_CAPABILITY_CATEGORIES],
        capabilities: listToolCapabilities({
          butlerData: input.butlerData,
          webSearchProvider: input.webSearchProvider,
          category: category.category,
          includeDisabled: call.args.include_disabled !== false,
          currentToolNames,
        }),
      };
    },
    "get_memory_health": async (_call: ToolCall) => ({
      ok: true,
      ...readMemoryHealth({
        butlerData: input.butlerData,
      }),
    }),
  };
}

function parseToolCategory(value: unknown): {
  category?: ToolCapabilityCategory;
  invalid?: string;
} {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string") return { invalid: String(value) };
  const normalized = value.trim();
  if (!normalized) return {};
  const lower = normalized.toLowerCase();
  if (lower === "shell" || lower === "terminal" || lower === "execution" || lower === "execute") {
    return { category: "command" };
  }
  if (lower === "filesystem" || lower === "files") {
    return { category: "file" };
  }
  if ((TOOL_CAPABILITY_CATEGORIES as readonly string[]).includes(lower)) {
    return { category: lower as ToolCapabilityCategory };
  }
  return { invalid: normalized };
}

function resolveCurrentToolNames(value: readonly string[] | (() => readonly string[]) | undefined): Set<string> | null {
  if (!value) return null;
  const names = typeof value === "function" ? value() : value;
  return new Set(names);
}

function capabilityAvailability(tool: ButlerToolDefinition, input: {
  butlerData: string;
  webSearchProvider?: WebSearchProvider;
}): { enabled: boolean; disabled_reason: string | null } {
  const availability = nativeToolAvailability(tool, input);
  return {
    enabled: availability.enabled,
    disabled_reason: availability.disabledReason,
  };
}

function listToolCapabilities(input: {
  butlerData: string;
  webSearchProvider?: WebSearchProvider;
  category?: ToolCapabilityCategory;
  includeDisabled?: boolean;
  currentToolNames?: Set<string> | null;
}): ToolCapabilityView[] {
  const includeDisabled = input.includeDisabled !== false;
  const currentToolNames = input.currentToolNames ?? null;
  return BUTLER_TOOLS
    .map((tool) => {
      const metadata = TOOL_CAPABILITY_METADATA[tool.name] ?? DEFAULT_TOOL_CAPABILITY;
      const availability = capabilityAvailability(tool, input);
      const currentTurnSelected = currentToolNames === null ? null : currentToolNames.has(tool.name);
      const currentTurnCallable = currentTurnSelected === null ? null : currentTurnSelected && availability.enabled;
      return {
        name: tool.name,
        description: tool.description,
        category: metadata.category,
        enabled: availability.enabled,
        disabled_reason: availability.disabled_reason,
        current_turn_selected: currentTurnSelected,
        current_turn_callable: currentTurnCallable,
        omitted_by_profile: currentTurnSelected === null ? null : !currentTurnSelected,
        availability_scope: currentTurnCallable === true ? "current_turn" as const : "registry" as const,
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
