import type {
  ToolCapabilityCategory,
  ToolCatalogEntry,
  ToolCatalogProvider,
} from "./types.ts";

export interface ToolSearchInput {
  catalog: readonly ToolCatalogEntry[];
  query?: string;
  capability?: string;
  category?: ToolCapabilityCategory;
  provider?: ToolCatalogProvider;
  includeDisabled?: boolean;
  limit?: number;
}

export interface ToolSearchResult {
  id: string;
  name: string;
  namespace: string | null;
  provider: ToolCatalogProvider;
  category: ToolCapabilityCategory;
  summary: string;
  tags: string[];
  risk_level: ToolCatalogEntry["riskLevel"];
  enabled: boolean;
  disabled_reason: string | null;
  recovery_hint: string | null;
  schema_digest: string;
}

export function searchToolCatalog(input: ToolSearchInput): ToolSearchResult[] {
  const includeDisabled = input.includeDisabled !== false;
  const queryTerms = tokenize(input.query);
  const capabilityTerms = tokenize(input.capability);
  const limit = normalizeLimit(input.limit);

  return input.catalog
    .filter((entry) => includeDisabled || entry.enabled)
    .filter((entry) => !input.category || entry.category === input.category)
    .filter((entry) => !input.provider || entry.provider === input.provider)
    .map((entry) => {
      const queryScore = scoreEntry(entry, queryTerms, []);
      const capabilityScore = scoreEntry(entry, [], capabilityTerms);
      return { entry, queryScore, capabilityScore };
    })
    .filter((ranked) => queryTerms.length === 0 || ranked.queryScore > 0)
    .filter((ranked) => capabilityTerms.length === 0 || ranked.capabilityScore > 0)
    .map((ranked) => ({
      entry: ranked.entry,
      score: ranked.queryScore + ranked.capabilityScore,
    }))
    .sort((a, b) => b.score - a.score || compareStableStrings(a.entry.id, b.entry.id))
    .slice(0, limit)
    .map((ranked) => compactToolSearchResult(ranked.entry));
}

function compactToolSearchResult(entry: ToolCatalogEntry): ToolSearchResult {
  return {
    id: entry.id,
    name: entry.name,
    namespace: entry.namespace,
    provider: entry.provider,
    category: entry.category,
    summary: entry.summary,
    tags: entry.tags,
    risk_level: entry.riskLevel,
    enabled: entry.enabled,
    disabled_reason: entry.disabledReason,
    recovery_hint: entry.recoveryHint,
    schema_digest: entry.schemaDigest,
  };
}

function scoreEntry(
  entry: ToolCatalogEntry,
  queryTerms: readonly string[],
  capabilityTerms: readonly string[],
): number {
  return (
    scoreTerms(entry, queryTerms, { exactName: 80, tag: 20, category: 16, provider: 10, summary: 4 })
    + scoreTerms(entry, capabilityTerms, { exactName: 24, tag: 28, category: 20, provider: 8, summary: 5 })
  );
}

function scoreTerms(
  entry: ToolCatalogEntry,
  terms: readonly string[],
  weights: { exactName: number; tag: number; category: number; provider: number; summary: number },
): number {
  if (terms.length === 0) return 0;
  const name = normalize(entry.name);
  const summary = normalize(entry.summary);
  const tags = entry.tags.map(normalize);
  let score = 0;
  for (const term of terms) {
    if (name === term) score += weights.exactName;
    if (name.includes(term)) score += Math.floor(weights.exactName / 2);
    if (entry.category === term) score += weights.category;
    if (entry.provider === term) score += weights.provider;
    if (tags.some((tag) => tag === term || tag.includes(term))) score += weights.tag;
    if (summary.includes(term)) score += weights.summary;
  }
  return score;
}

function tokenize(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value
    .split(/[^\p{L}\p{N}_-]+/u)
    .map(normalize)
    .filter(Boolean))];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(50, Math.floor(value)));
}

function compareStableStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
