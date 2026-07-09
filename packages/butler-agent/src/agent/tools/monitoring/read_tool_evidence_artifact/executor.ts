import { createMonitoringToolHandlers } from "../shared.ts";

export function createReadToolEvidenceArtifactToolHandler(input: Parameters<typeof createMonitoringToolHandlers>[0]) {
  return createMonitoringToolHandlers(input).read_tool_evidence_artifact;
}
