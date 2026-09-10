import type {
  RetrievalEvidenceRequirement,
  RetrievalGeneratedQuery,
  RetrievalStrategy,
} from "../../../cognition/memory/retrieval-planning.ts";
import {
  recallMemoryEvidence,
  recallMemoryEvidenceWithVector,
} from "../../../cognition/memory/quality.ts";
import type { createMemoryToolHandlers } from "../shared.ts";
import type { ButlerToolCall } from "../../types.ts";
import {
  readActiveDescriptor,
  recallMemory,
} from "../../../cognition/memory/index.ts";
import { graphemeCount } from "../../../cognition/memory/projection/unicode.ts";
import { createLazyConversationProjectionReader } from "../../../conversation/projection-reader-store.ts";
import { readRecallResultEvidenceFacts } from "../../../cognition/memory/recall/engine.ts";

const RECALL_VECTOR_TIMEOUT_MS = 10_000;

export function createRecallMemoryToolHandler(
  input: Parameters<typeof createMemoryToolHandlers>[0],
) {
  return async (
    call: ButlerToolCall,
    runtimeContext?: { effectOccurrenceId?: string },
  ) => {
    const cue = typeof call.args.cue === "string" ? call.args.cue.trim() : "";
    if (!cue) throw new Error("recall_memory requires cue");
    if (call.toolContractVersion === undefined) {
      return legacyUnversionedRecall(call, input, cue);
    }
    if ((call.toolContractVersion ?? 1) === 2) {
      if (
        !input.sessionId?.trim() || !input.turnId?.trim() ||
        !input.currentUserMessage?.trim() ||
        !runtimeContext?.effectOccurrenceId?.trim()
      ) {
        throw new Error(
          "recall_memory v2 requires runtime session and turn binding",
        );
      }
      const descriptor = readActiveDescriptor(input.butlerData);
      const limit = call.args.limit === undefined ? 6 : call.args.limit;
      if (
        !Number.isSafeInteger(limit) || (limit as number) < 1 ||
        (limit as number) > 20
      ) throw new Error("invalid_arguments");
      const scope = normalizeV2Scope(call.args.scope, input.projectId);
      const projectFilter = normalizeProjectFilter(call.args.project_filter);
      const projectIds = boundedStringArray(call.args.project_ids, 16, 512);
      const sessionIds = boundedStringArray(call.args.session_ids, 32, 512);
      validateCanonicalScopeIds({
        butlerData: input.butlerData,
        currentSessionId: input.sessionId,
        currentProjectId: input.projectId ?? null,
        scope,
        projectIds,
        sessionIds,
      });
      const result = await recallMemory({
        context: {
          butlerData: input.butlerData,
          target: {
            kind: "active",
            expected_generation: descriptor.generation_id,
          },
          signal: call.signal ?? new AbortController().signal,
        },
        cue,
        seedPhrases: boundedStringArray(call.args.seed_phrases, 16, 512),
        vectorQueries: boundedStringArray(call.args.vector_queries, 4, 2_048),
        includeVector: call.args.include_vector !== false,
        includeInternal: call.args.include_internal === true,
        limit: limit as number,
        scope,
        projectFilter,
        projectIds,
        sessionIds,
        asOf: typeof call.args.as_of === "string"
          ? call.args.as_of
          : new Date().toISOString(),
        asOfExplicit: typeof call.args.as_of === "string",
        time: normalizeTime(call.args.time),
        cursor: typeof call.args.cursor === "string"
          ? call.args.cursor
          : undefined,
        runtime: {
          sessionId: input.sessionId,
          turnId: input.turnId,
          currentUserMessage: input.currentUserMessage,
          nativeOperationId: runtimeContext.effectOccurrenceId,
          projectId: input.projectId ?? null,
        },
      });
      return { ok: true, ...result };
    }
    const generatedQueries = normalizeGeneratedQueries(
      call.args.generated_queries,
    );
    const strategies = normalizeEnumArray(
      call.args.strategies,
      RECALL_STRATEGIES,
    );
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
    if (evidenceRequired.includes("exact_quote")) {
      return {
        ok: true,
        cue,
        seeds: [],
        items: [],
        results: [],
        abstained: true,
        diagnostics: [
          "evidence=exact_quote_requires_query_memory",
          "legacy_exact_lookup_not_executed",
        ],
      };
    }
    if (
      !input.sessionId?.trim() || !input.turnId?.trim() ||
      !input.currentUserMessage?.trim() ||
      !runtimeContext?.effectOccurrenceId?.trim()
    ) {
      throw new Error(
        "recall_memory v1 requires runtime session and turn binding",
      );
    }
    const descriptor = readActiveDescriptor(input.butlerData);
    const scope: "current_project" | "all_user_sessions" =
      call.args.scope === "current_project"
      ? "current_project"
      : "all_user_sessions";
    const admittedChannels = v1AdmittedChannels(strategies);
    const includeVector = call.args.include_vector !== false &&
      admittedChannels.vector;
    const result = await recallMemory({
      context: {
        butlerData: input.butlerData,
        target: {
          kind: "active",
          expected_generation: descriptor.generation_id,
        },
        signal: call.signal ?? new AbortController().signal,
      },
      cue,
      seedPhrases: generatedQueries.filter((query) =>
        query.strategy !== "search_vector_episode",
      ).map((query) => query.query),
      vectorQueries,
      includeVector,
      includeInternal: call.args.include_internal === true,
      limit: typeof call.args.limit === "number" ? call.args.limit : 6,
      scope,
      projectFilter: "any",
      projectIds: [],
      sessionIds: [],
      asOf: new Date().toISOString(),
      asOfExplicit: false,
      admittedChannels,
      runtime: {
        sessionId: input.sessionId,
        turnId: input.turnId,
        currentUserMessage: input.currentUserMessage,
        nativeOperationId: runtimeContext.effectOccurrenceId,
        projectId: input.projectId ?? null,
      },
    });
    const strategyResults = result.results.filter((item) =>
      v1StrategiesPermit(strategies, item.channels),
    );
    const evidenceContext = {
      projectId: input.projectId ?? null,
    };
    const missingEvidence = evidenceRequired.filter((requirement) =>
      !strategyResults.some((item) =>
        v1ResultSatisfiesEvidence(requirement, item, evidenceContext),
      ),
    );
    const admittedResults = missingEvidence.length
      ? []
      : evidenceRequired.length
      ? strategyResults.filter((item) =>
        evidenceRequired.some((requirement) =>
          v1ResultSatisfiesEvidence(requirement, item, evidenceContext),
        ),
      )
      : strategyResults;
    const legacyResults = admittedResults.map((item) => ({
      text: item.evidence[0]!.excerpt,
      path: item.evidence[0]!.source_ref,
      source: v1ResultSource(item.channels),
      summary: item.summary,
    }));
    return {
      ok: true,
      ...result,
      cue,
      seeds: [],
      results: legacyResults,
      items: legacyResults.map((item) => ({
        summary: item.summary,
        source: item.source,
        provenance: [item.path],
        related_nodes: [],
        score_breakdown: {},
      })),
      abstained: legacyResults.length === 0,
      diagnostics: [
        ...result.diagnostics,
        ...(strategies.includes("query_exact_transcript")
          ? ["legacy_exact_lookup_not_executed"]
          : []),
        ...missingEvidence.map((requirement) =>
          `evidence_missing=${requirement}`,
        ),
      ],
    };
  };
}

function v1AdmittedChannels(strategies: RetrievalStrategy[]) {
  const all = strategies.length === 0;
  return {
    graph: all || strategies.includes("read_graph_memory"),
    lexical: all || strategies.includes("search_lexical_memory"),
    vector: all || strategies.includes("search_vector_episode"),
    context: all || strategies.includes("read_recent_context"),
    explicit: all || strategies.includes("read_explicit_memory"),
    task: all || strategies.includes("read_task_state"),
  };
}

function v1StrategiesPermit(
  strategies: RetrievalStrategy[],
  channels: Array<"graph" | "lexical" | "vector" | "context" | "explicit">,
): boolean {
  if (!strategies.length) return true;
  const allowed = new Set<string>();
  for (const strategy of strategies) {
    if (strategy === "search_lexical_memory") allowed.add("lexical");
    if (strategy === "search_vector_episode") allowed.add("vector");
    if (strategy === "read_graph_memory") allowed.add("graph");
    if (strategy === "read_recent_context") allowed.add("context");
    if (strategy === "read_explicit_memory") allowed.add("explicit");
  }
  return channels.some((channel) => allowed.has(channel));
}

function v1ResultSatisfiesEvidence(
  requirement: RetrievalEvidenceRequirement,
  item: Awaited<ReturnType<typeof recallMemory>>["results"][number],
  context: {
    projectId: string | null;
  },
): boolean {
  if (!item.evidence.length) return false;
  const facts = readRecallResultEvidenceFacts(item);
  if (requirement === "vector_episode_hit") {
    return item.channels.includes("vector");
  }
  if (requirement === "graph_relation_hit") {
    return item.channels.includes("graph") && item.association_path.length > 0;
  }
  if (requirement === "recent_turn_hit") {
    return item.channels.includes("context") &&
      facts?.recentSourceHit === true;
  }
  if (requirement === "explicit_rule_hit") {
    return item.channels.includes("explicit") &&
      facts?.explicitRuleSourceHit === true;
  }
  if (requirement === "project_memory_hit") {
    return context.projectId !== null &&
      facts?.projectIds.has(context.projectId) === true;
  }
  // Task continuity and exact transcript require source owners outside this result.
  return false;
}

function v1ResultSource(
  channels: Array<"graph" | "lexical" | "vector" | "context" | "explicit">,
): string {
  return channels.includes("vector")
    ? "vector"
    : channels.includes("explicit")
    ? "explicit"
    : channels.includes("context")
    ? "context"
    : channels.includes("lexical")
    ? "lexical"
    : "graph";
}

async function legacyUnversionedRecall(
  call: ButlerToolCall,
  input: Parameters<typeof createMemoryToolHandlers>[0],
  cue: string,
) {
  const generatedQueries = normalizeGeneratedQueries(
      call.args.generated_queries,
    ),
    strategies = normalizeEnumArray(call.args.strategies, RECALL_STRATEGIES),
    evidenceRequired = normalizeEnumArray(
      call.args.evidence_required,
      RECALL_EVIDENCE_REQUIREMENTS,
    );
  const vectorQueries = mergeQueries(
    stringArray(call.args.vector_queries),
    generatedQueries.filter((query) =>
      query.strategy === "search_vector_episode",
    ).map((query) => query.query),
  );
  const evidencePolicy = strategies.length || evidenceRequired.length
    ? {
      strategies,
      evidenceRequired,
      retrievalPlan: { strategies, evidence_required: evidenceRequired },
    }
    : undefined;
  const honorVectorOptOut = call.args.include_vector === false &&
    (strategies.includes("query_exact_transcript") ||
      evidenceRequired.includes("exact_quote"));
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
}

function validateCanonicalScopeIds(input: {
  butlerData: string;
  currentSessionId: string;
  currentProjectId: string | null;
  scope: "current_session" | "current_project" | "all_user_sessions";
  projectIds: string[];
  sessionIds: string[];
}): void {
  const store = createLazyConversationProjectionReader({
    butlerData: input.butlerData,
  });
  try {
    if (!store.isAvailable()) throw new Error("backend_unavailable");
    const current = store.getSession(input.currentSessionId);
    if (
      !current || current.status === "deleted" ||
      current.project_id !== input.currentProjectId
    ) throw new Error("invalid_scope");
    const selectedSessions = input.sessionIds.map((id) => store.getSession(id));
    if (
      selectedSessions.some((session) =>
        !session || session.status === "deleted",
      )
    ) throw new Error("invalid_scope");
    if (
      input.scope === "current_session" &&
      selectedSessions.some((session) => session!.id !== current.id)
    ) throw new Error("invalid_scope");
    if (
      input.scope === "current_project" && (input.currentProjectId === null ||
        selectedSessions.some((session) =>
          session!.project_id !== input.currentProjectId,
        ))
    ) throw new Error("invalid_scope");
    if (
      input.scope !== "all_user_sessions" &&
      (input.currentProjectId === null ||
        input.projectIds.some((id) => id !== input.currentProjectId))
    ) {
      if (input.projectIds.length > 0) throw new Error("invalid_scope");
    }
    if (input.projectIds.length > 0) {
      for (const projectId of input.projectIds) {
        if (
          store.listSessions({ projectId, includeArchived: true, limit: 1 })
            .length === 0
        ) {
          throw new Error("invalid_scope");
        }
      }
    }
  } finally {
    store.close();
  }
}

function normalizeV2Scope(value: unknown, projectId: string | undefined) {
  if (
    value === "current_session" || value === "current_project" ||
    value === "all_user_sessions"
  ) return value;
  if (value !== undefined) throw new Error("invalid_arguments");
  return projectId ? "current_project" as const : "all_user_sessions" as const;
}

function normalizeProjectFilter(value: unknown) {
  if (value === "unassigned" || value === "selected" || value === "any") {
    return value;
  }
  if (value !== undefined) throw new Error("invalid_arguments");
  return "any" as const;
}

function boundedStringArray(
  value: unknown,
  maxItems: number,
  maxGraphemes: number,
): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) || value.length > maxItems ||
    value.some((item) =>
      typeof item !== "string" || !item.trim() ||
      graphemeCount(item) > maxGraphemes,
    )
  ) {
    throw new Error("invalid_arguments");
  }
  return value.map((item) => (item as string).trim());
}

function normalizeTime(
  value: unknown,
): { from: string; to: string; basis: "conversation" | "event" } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("recall_memory invalid time");
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.from !== "string" || typeof item.to !== "string" ||
    (item.basis !== "conversation" && item.basis !== "event")
  ) {
    throw new Error("recall_memory invalid time");
  }
  return { from: item.from, to: item.to, basis: item.basis };
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

function normalizeEnumArray<T extends string>(
  value: unknown,
  allowed: Set<T>,
): T[] {
  if (!Array.isArray(value)) return [];
  const output: T[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !allowed.has(item as T) ||
      output.includes(item as T)
    ) {
      continue;
    }
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
      ? (raw.strategy as RetrievalStrategy)
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
