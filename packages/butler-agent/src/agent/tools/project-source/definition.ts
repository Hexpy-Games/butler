import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const readProjectSourceDefinition: ButlerToolDefinition = {
  type: "function", name: "read_project_source",
  description: "Read the complete, immutable public project source snapshot explicitly attached to this turn. Use originalRef.fileId from project source context. Continue with next_cursor until truncated is false. This reads the accepted snapshot, not current live Ledger state; arbitrary paths and other files are not accepted.",
  parameters: { type: "object", additionalProperties: false, properties: {
    file_id: { type: "string", description: "Exact originalRef.fileId from the attached project source context." },
    cursor: { type: "string", description: "First page: omit or use an empty string. Later pages: copy next_cursor exactly from the previous result. Never invent a cursor." },
  }, required: ["file_id"] },
  effectBoundary: "none", concurrencySafe: true, interruptBehavior: "continue", transcriptVisibility: "visible",
};
export const readProjectSourceMetadata: ToolCapabilityMetadata = {
  category: "project", tags: ["project", "source", "read", "snapshot"],
  safetyNotes: ["Only server-admitted snapshot identities from this turn can be read. No workspace or Ledger mutation permission is added."],
};
