import { createHash } from "node:crypto";
import type {
  ButlerToolDefinition,
  ToolCapabilityCategory,
  ToolCapabilityMetadata,
  ToolCatalogEntry,
  ToolCatalogProvider,
  ToolCatalogRiskLevel,
} from "./types.ts";

export interface ToolAvailability {
  enabled: boolean;
  disabledReason: string | null;
  recoveryHint?: string | null;
}

export interface NativeToolCatalogInput {
  tools: readonly ButlerToolDefinition[];
  metadata: Record<string, ToolCapabilityMetadata>;
  resolveAvailability?: (tool: ButlerToolDefinition) => ToolAvailability | null | undefined;
}

export interface ExternalToolCatalogInput {
  name: string;
  provider: Exclude<ToolCatalogProvider, "native">;
  category: ToolCapabilityCategory;
  description: string;
  tags?: readonly string[];
  riskLevel?: ToolCatalogRiskLevel;
  namespace?: string;
  schema?: unknown;
  disabledReason?: string | null;
  recoveryHint?: string | null;
}

const DEFAULT_DISABLED_REASON = "tool is disabled by runtime availability policy";
const DEFAULT_RECOVERY_HINT = "Use tool_search or tool_describe to choose another currently enabled tool.";

export function buildNativeToolCatalog(input: NativeToolCatalogInput): ToolCatalogEntry[] {
  return input.tools
    .map((tool) => {
      const metadata = requireNativeMetadata(tool, input.metadata);
      const availability = normalizeAvailability(input.resolveAvailability?.(tool)) ?? {
        enabled: true,
        disabledReason: null,
      };
      return catalogEntry({
        id: stableToolCatalogId({ provider: "native", name: tool.name }),
        name: tool.name,
        namespace: null,
        provider: "native",
        category: metadata.category,
        description: tool.description,
        tags: metadata.tags,
        riskLevel: riskLevelForNativeTool(tool, metadata),
        enabled: availability.enabled,
        disabledReason: availability.disabledReason,
        recoveryHint: availability.recoveryHint ?? recoveryHintForDisabled(availability.disabledReason),
        schema: tool.parameters,
      });
    })
    .sort(compareToolCatalogEntries);
}

export function buildExternalToolCatalog(inputs: readonly ExternalToolCatalogInput[]): ToolCatalogEntry[] {
  return inputs
    .map((input) => {
      const name = normalizeToolName(input.name);
      const disabledReason = normalizeDisabledReason(input.disabledReason);
      const recoveryHint = normalizeRecoveryHint(input.recoveryHint) ?? recoveryHintForDisabled(disabledReason);
      const namespace = normalizeNamespace(input.namespace);
      return catalogEntry({
        id: stableToolCatalogId({
          provider: input.provider,
          namespace,
          name,
        }),
        name,
        namespace,
        provider: input.provider,
        category: input.category,
        description: input.description,
        tags: input.tags ?? [],
        riskLevel: input.riskLevel ?? defaultRiskLevelForCategory(input.category),
        enabled: disabledReason === null,
        disabledReason,
        recoveryHint,
        schema: input.schema ?? {},
      });
    })
    .sort(compareToolCatalogEntries);
}

export function compareToolCatalogEntries(a: ToolCatalogEntry, b: ToolCatalogEntry): number {
  return (
    compareStableStrings(a.provider, b.provider)
    || compareStableStrings(a.category, b.category)
    || compareStableStrings(a.name, b.name)
    || compareStableStrings(a.id, b.id)
  );
}

export function stableToolCatalogId(input: {
  provider: ToolCatalogProvider;
  name: string;
  namespace?: string | null;
}): string {
  const name = requireCatalogIdSegment(input.name, "name");
  const namespace = input.namespace ? requireCatalogIdSegment(input.namespace, "namespace") : null;
  return [input.provider, namespace, name].filter(Boolean).join(":");
}

export function parseToolCatalogId(id: string): {
  provider: ToolCatalogProvider;
  namespace: string | null;
  name: string;
} | null {
  const parts = id.split(":");
  const provider = parts[0] as ToolCatalogProvider | undefined;
  if (provider !== "native" && provider !== "mcp" && provider !== "plugin") return null;
  if (provider === "native" && parts.length === 2) {
    return { provider, namespace: null, name: decodeCatalogIdSegment(parts[1]) };
  }
  if ((provider === "mcp" || provider === "plugin") && parts.length === 3) {
    return {
      provider,
      namespace: decodeCatalogIdSegment(parts[1]),
      name: decodeCatalogIdSegment(parts[2]),
    };
  }
  return null;
}

export function schemaDigest(schema: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(schema)).digest("hex")}`;
}

function catalogEntry(input: {
  id: string;
  name: string;
  namespace: string | null;
  provider: ToolCatalogProvider;
  category: ToolCapabilityCategory;
  description: string;
  tags: readonly string[];
  riskLevel: ToolCatalogRiskLevel;
  enabled: boolean;
  disabledReason: string | null;
  recoveryHint: string | null;
  schema: unknown;
}): ToolCatalogEntry {
  return {
    id: input.id,
    name: input.name,
    namespace: input.namespace,
    provider: input.provider,
    category: input.category,
    summary: summarizeDescription(input.description),
    tags: [...new Set(input.tags)].sort(compareStableStrings),
    riskLevel: input.riskLevel,
    enabled: input.enabled,
    disabledReason: input.disabledReason,
    recoveryHint: input.recoveryHint,
    schemaDigest: schemaDigest(input.schema),
  };
}

function summarizeDescription(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= 220) return normalized;
  return `${normalized.slice(0, 217).trimEnd()}...`;
}

function riskLevelForNativeTool(
  tool: ButlerToolDefinition,
  metadata: ToolCapabilityMetadata,
): ToolCatalogRiskLevel {
  if (!tool.concurrencySafe || metadata.category === "command") return "high";
  if (metadata.category === "file" && tool.name !== "read_file" && tool.name !== "grep_files") return "high";
  return defaultRiskLevelForCategory(metadata.category);
}

function defaultRiskLevelForCategory(category: ToolCapabilityCategory): ToolCatalogRiskLevel {
  switch (category) {
    case "command":
    case "automation":
    case "dispatch":
    case "mcp":
    case "work":
      return "high";
    case "file":
    case "search":
    case "data":
    case "memory":
    case "project":
    case "skill":
      return "medium";
    case "monitoring":
    case "todo":
    case "control":
      return "low";
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function normalizeAvailability(value: ToolAvailability | null | undefined): ToolAvailability | null {
  if (!value) return null;
  const disabledReason = normalizeDisabledReason(value.disabledReason);
  const recoveryHint = normalizeRecoveryHint(value.recoveryHint);
  if (!value.enabled) {
    return {
      enabled: false,
      disabledReason: disabledReason ?? DEFAULT_DISABLED_REASON,
      recoveryHint: recoveryHint ?? DEFAULT_RECOVERY_HINT,
    };
  }
  return {
    enabled: disabledReason === null,
    disabledReason,
    recoveryHint: recoveryHint ?? recoveryHintForDisabled(disabledReason),
  };
}

function normalizeDisabledReason(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeRecoveryHint(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function recoveryHintForDisabled(disabledReason: string | null): string | null {
  return disabledReason ? DEFAULT_RECOVERY_HINT : null;
}

function normalizeNamespace(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeToolName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Tool catalog name must not be empty");
  return trimmed;
}

function requireNativeMetadata(
  tool: ButlerToolDefinition,
  metadata: Record<string, ToolCapabilityMetadata>,
): ToolCapabilityMetadata {
  const capability = metadata[tool.name];
  if (!capability) throw new Error(`Missing native tool capability metadata: ${tool.name}`);
  return capability;
}

function requireCatalogIdSegment(value: string, field: string): string {
  const trimmed = field === "name" ? normalizeToolName(value) : value.trim();
  if (!trimmed) throw new Error(`Tool catalog ${field} must not be empty`);
  return encodeURIComponent(trimmed);
}

function decodeCatalogIdSegment(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function compareStableStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
