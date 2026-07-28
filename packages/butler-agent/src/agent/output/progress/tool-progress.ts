import type { RuntimeMessageLanguage } from "../messages.ts";
import type { ToolProgressSummary } from "../../tool-support/index.ts";
import { safeToolDetailRows, safeToolInputLabel } from "./arguments.ts";
import { contextualToolProgressSummary } from "./contextual.ts";
import { workBlockLabelForTool } from "./labels.ts";
import { activityKindForTool } from "./tool-progress-metadata.ts";

const TOOL_PROGRESS_DISPLAY_NAME_BY_TOOL_NAME: Record<string, string> = {
  get_context_monitor: "Get Context Monitor",
  get_memory_health: "Get Memory Health",
  get_usage_monitor: "Get Usage Monitor",
  list_tool_capabilities: "List Tool Capabilities",
  read_tool_evidence_artifact: "Read Tool Evidence Artifact",
  read_tool_output_artifact: "Read Tool Output Artifact",
  tool_call: "Tool Call",
  tool_describe: "Tool Describe",
  tool_search: "Tool Search",
};

export function summarizeToolProgress(
  name: string,
  args: Record<string, unknown>,
  language: RuntimeMessageLanguage,
): ToolProgressSummary {
  const contextual = contextualToolProgressSummary(name, args);
  if (contextual) {
    return {
      ...contextual,
      workBlockLabel: workBlockLabelForTool(name, contextual.kind, contextual.inputLabel, language),
    };
  }
  const kind = activityKindForTool(name);
  const toolName = displayToolName(name, kind);
  const inputLabel = safeToolInputLabel(name, args, kind);
  return {
    kind,
    toolName,
    safeLabel: inputLabel ? `${toolName}: ${inputLabel}` : toolName,
    workBlockLabel: workBlockLabelForTool(name, kind, inputLabel, language),
    inputLabel,
    detailRows: safeToolDetailRows(name, args),
  };
}

export { activityKindForTool } from "./tool-progress-metadata.ts";

export function displayToolName(name: string, kind: ToolProgressSummary["kind"]): string {
  const explicitDisplayName = TOOL_PROGRESS_DISPLAY_NAME_BY_TOOL_NAME[name];
  if (explicitDisplayName) {
    return explicitDisplayName;
  }
  if (kind === "ran_command") {
    return "Command";
  }
  if (kind === "edited") {
    return "Edit";
  }
  if (kind === "searched") {
    return name === "web_search" ? "Web search" : "Search";
  }
  if (kind === "read") {
    return "Read";
  }
  if (kind === "dispatch") {
    return "Dispatch";
  }
  return name
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((part) => part[0]?.toLocaleUpperCase("en-US") + part.slice(1))
    .join(" ") || "Tool";
}
