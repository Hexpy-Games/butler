import type { FunctionToolDefinition } from "../../integrations/providers/provider.ts";
import type { PublicWorkObligationKind } from "../turn/native-tool-types.ts";

export interface ButlerToolDefinition extends FunctionToolDefinition {
  concurrencySafe: boolean;
  interruptBehavior: "continue" | "cancel";
  transcriptVisibility: "visible";
}

export type ToolCapabilityCategory =
  | "search"
  | "data"
  | "command"
  | "file"
  | "work"
  | "monitoring"
  | "automation"
  | "todo"
  | "memory"
  | "project"
  | "skill"
  | "mcp"
  | "dispatch"
  | "control";

export interface ToolCapabilityMetadata {
  category: ToolCapabilityCategory;
  tags: string[];
  safetyNotes: string[];
  satisfiesCompletionObligations?: PublicWorkObligationKind[];
}
