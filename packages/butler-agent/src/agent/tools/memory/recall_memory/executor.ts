import {
  recallMemoryEvidence,
  recallMemoryEvidenceWithVector,
} from "../../../cognition/memory/quality.ts";
import type {
  RetrievalEvidenceRequirement,
  RetrievalGeneratedQuery,
  RetrievalStrategy,
} from "../../../cognition/memory/retrieval-planning.ts";
import type { createMemoryToolHandlers } from "../shared.ts";

const RECALL_VECTOR_TIMEOUT_MS = 10_000;

export function createRecallMemoryToolHandler(input: Parameters<typeof createMemoryToolHandlers>[0]) {
  return async (call: { args: Record<string, unknown> }) => {
    const cue = typeof call.args.cue === "string" ? call.args.cue.trim() : "";
    if (!cue) throw new Error("recall_memory requires cue");
    const generatedQueries = normalizeGeneratedQueries(call.args.generated_queries);
    const strategies = normalizeEnumArray(call.args.strategies, RECALL_STRATEGIES);
    const evidenceRequired = normalizeEnumArray(
      call.args.evidence_required,
      RECALL_EVIDENCE_REQUIREMENTS,
    );
    const vectorQueries = mergeQueries(
      stringArray(call.args.vector_queries),
      generatedQueries
        .filter((query) => query.strategy === "search_vector_episode")
        .map((query) => query.query),
    );
    const evidencePolicy = strategies.length > 0 || evidenceRequired.length > 0
      ? {
        strategies,
        evidenceRequired,
        retrievalPlan: { strategies, evidence_required: evidenceRequired },
      }
      : undefined;
    const honorVectorOptOut = call.args.include_vector === false && (
      strategies.includes("query_exact_transcript") ||
      evidenceRequired.includes("exact_quote")
    );
    const recall = honorVectorOptOut
      ? recallMemoryEvidence({
        butlerData: input.butlerData,
        cue,
        projectId: input.projectId,
        limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
        evidencePolicy,
      })
      : await recallMemoryEvidenceWithVector({
        butlerData: input.butlerData,
        cue,
        projectId: input.projectId,
        limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
        vectorQueries,
        evidencePolicy,
        vectorBackend: input.memoryVectorBackend,
        vectorTimeoutMs: input.memoryVectorTimeoutMs ?? RECALL_VECTOR_TIMEOUT_MS,
      });
    return {
      ok: true,
      ...recall,
      diagnostics: [
        ...recall.diagnostics,
        ...(call.args.include_vector === false && !honorVectorOptOut
          ? ["vector=forced:model-opt-out-ignored"]
          : []),
      ],
    };
  };
}

const RECALL_STRATEGIES = new Set<RetrievalStrategy>([
  "read_recent_context",
  "query_exact_transcript",
  "search_lexical_memory",
  "search_vector_episode",
  "read_graph_memory",
  "read_explicit_memory",
  "read_task_state",
]);

const RECALL_EVIDENCE_REQUIREMENTS = new Set<RetrievalEvidenceRequirement>([
  "exact_quote",
  "recent_turn_hit",
  "task_continuity",
  "project_memory_hit",
  "vector_episode_hit",
  "explicit_rule_hit",
  "graph_relation_hit",
]);

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeEnumArray<T extends string>(value: unknown, allowed: Set<T>): T[] {
  if (!Array.isArray(value)) return [];
  const output: T[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item as T) || output.includes(item as T)) continue;
    output.push(item as T);
  }
  return output;
}

function normalizeGeneratedQueries(value: unknown): RetrievalGeneratedQuery[] {
  if (!Array.isArray(value)) return [];
  const output: RetrievalGeneratedQuery[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const strategy = typeof raw.strategy === "string" &&
      RECALL_STRATEGIES.has(raw.strategy as RetrievalStrategy)
      ? raw.strategy as RetrievalStrategy
      : null;
    const query = typeof raw.query === "string" ? raw.query.trim() : "";
    if (!strategy || query.length < 2) continue;
    const key = `${strategy}:${query.toLocaleLowerCase("en-US")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ strategy, query });
  }
  return output;
}

function mergeQueries(...groups: string[][]): string[] | undefined {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of groups.flat()) {
    const query = value.trim();
    const key = query.toLocaleLowerCase("en-US");
    if (query.length < 2 || seen.has(key)) continue;
    seen.add(key);
    output.push(query);
  }
  return output.length > 0 ? output : undefined;
}
