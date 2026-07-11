import { createGetContextMonitorToolHandler } from "./get_context_monitor/executor.ts";
import { createReadToolEvidenceArtifactToolHandler } from "./read_tool_evidence_artifact/executor.ts";
import { createReadToolOutputArtifactToolHandler } from "./read_tool_output_artifact/executor.ts";
import { createGetUsageMonitorToolHandler } from "./get_usage_monitor/executor.ts";
import { createListToolCapabilitiesToolHandler } from "./list_tool_capabilities/executor.ts";
import { createGetMemoryHealthToolHandler } from "./get_memory_health/executor.ts";

export function createMonitoringToolHandlers(input: Parameters<typeof createGetContextMonitorToolHandler>[0]) {
  return {
    "get_context_monitor": createGetContextMonitorToolHandler(input),
    "read_tool_evidence_artifact": createReadToolEvidenceArtifactToolHandler(input),
    "read_tool_output_artifact": createReadToolOutputArtifactToolHandler(input),
    "get_usage_monitor": createGetUsageMonitorToolHandler(input),
    "list_tool_capabilities": createListToolCapabilitiesToolHandler(input),
    "get_memory_health": createGetMemoryHealthToolHandler(input),
  };
}
