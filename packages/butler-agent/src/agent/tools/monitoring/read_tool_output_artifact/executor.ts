import { createMonitoringToolHandlers } from "../shared.ts";

export function createReadToolOutputArtifactToolHandler(input: Parameters<typeof createMonitoringToolHandlers>[0]) {
  return createMonitoringToolHandlers(input).read_tool_output_artifact;
}
