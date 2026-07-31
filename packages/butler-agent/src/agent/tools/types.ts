import type { FunctionToolDefinition } from "../../integrations/providers/provider.ts";
import type { PublicWorkObligationKind } from "../tool-support/index.ts";

export type ButlerToolEffectBoundary =
  | "none"
  | "turn_local"
  | "reviewed_persistent"
  | "dynamic";

export interface ButlerToolDefinition extends FunctionToolDefinition {
  effectBoundary: ButlerToolEffectBoundary;
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

export type ToolCatalogProvider = "native" | "mcp" | "plugin";

export type ToolCatalogRiskLevel = "low" | "medium" | "high";

export interface ToolCatalogEntry {
  id: string;
  name: string;
  namespace: string | null;
  provider: ToolCatalogProvider;
  category: ToolCapabilityCategory;
  summary: string;
  tags: string[];
  riskLevel: ToolCatalogRiskLevel;
  enabled: boolean;
  disabledReason: string | null;
  recoveryHint: string | null;
  schemaDigest: string;
}
