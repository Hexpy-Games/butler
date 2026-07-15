import type { FunctionToolDefinition } from "../../integrations/providers/provider.ts";
import type { PublicWorkObligationKind } from "../turn/native/output/tool-types.ts";

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
  btcc?: {
    effects: Array<
      | "observe"
      | "plan_mutation"
      | "ledger_mutation"
      | "workspace_mutation"
      | "validation"
      | "external_mutation"
      | "control"
    >;
    purposes: Array<
      | "intent_grounding"
      | "planning"
      | "execution"
      | "review"
      | "consolidation"
      | "reporting"
    >;
    scopes: Array<"turn" | "task" | "project" | "workspace" | "external">;
    ledgerOperation?: "discover" | "read" | "mutate" | "validate" | "render" | "closeout";
  };
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
