import {
  ingestTaskOutcomeMemory,
  recallMemoryEvidence,
  recallMemoryEvidenceWithVector,
  updateExplicitMemory,
} from "../../cognition/memory/quality.ts";
import {
  createRetrievalPlan,
  type RetrievalEvidenceRequirement,
  type RetrievalGeneratedQuery,
  type RetrievalPlanningInput,
  type RetrievalPlanningResult,
  type RetrievalStrategy,
} from "../../cognition/memory/retrieval-planning.ts";
import type { VectorEpisodeBackend } from "../../cognition/memory/recall/vector.ts";
import { queryMemory } from "../../cognition/memory/exact-query.ts";
import { readReflectiveProfileSummary, type ProfilingMode } from "../../../personalization/profiling.ts";
import {
  readConversationContext,
  type ConversationContextDirection,
} from "../../context/conversation-context.ts";
import {
  updateFirstChatOnboarding,
  type FirstChatOnboardingPersonaPreset,
} from "../../../personalization/onboarding.ts";

type ToolCall = { args: Record<string, unknown> };

const RECALL_RETRIEVAL_STRATEGIES = new Set<RetrievalStrategy>([
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

const RECALL_MEMORY_TOOL_VECTOR_TIMEOUT_MS = 10_000;

export function createMemoryToolHandlers(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath?: string;
  sessionId?: string;
  projectId?: string;
  turnContext?: string;
  searchPlannerOriginalRequest?: string;
  workerModel?: string;
  searchPlannerModel?: string;
  memoryRetrievalPlanner?: (input: RetrievalPlanningInput) => Promise<RetrievalPlanningResult>;
  memoryVectorBackend?: VectorEpisodeBackend;
  memoryVectorTimeoutMs?: number;
}) {
  return {
    "ingest_task_memory": async (call: ToolCall) => {
      const taskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      if (!taskId) throw new Error("ingest_task_memory requires task_id");
      return ingestTaskOutcomeMemory({
        butlerData: input.butlerData,
        taskId,
      });
    },
    "recall_memory": async (call: ToolCall) => {
      const cue = typeof call.args.cue === "string" ? call.args.cue.trim() : "";
      if (!cue) throw new Error("recall_memory requires cue");
      const explicitVectorQueries = stringArray(call.args.vector_queries);
      const explicitGeneratedQueries = normalizeRecallGeneratedQueries(call.args.generated_queries);
      let strategies = normalizeRecallEnumArray(call.args.strategies, RECALL_RETRIEVAL_STRATEGIES);
      let evidenceRequired = normalizeRecallEnumArray(call.args.evidence_required, RECALL_EVIDENCE_REQUIREMENTS);
      let plannedGeneratedQueries = explicitGeneratedQueries;
      let plannerResult: RetrievalPlanningResult | null = null;
      const shouldPlanRecall = strategies.length === 0 &&
        evidenceRequired.length === 0 &&
        explicitGeneratedQueries.length === 0 &&
        (input.memoryRetrievalPlanner || input.searchPlannerModel || input.workerModel);
      if (shouldPlanRecall) {
        const planner = input.memoryRetrievalPlanner ?? createRetrievalPlan;
        plannerResult = await planner({
          request: input.searchPlannerOriginalRequest ?? cue,
          recentContext: input.turnContext,
          projectId: input.projectId,
          sessionId: input.sessionId,
          model: input.searchPlannerModel ?? input.workerModel,
        });
        strategies = plannerResult.plan.strategies;
        evidenceRequired = plannerResult.plan.evidence_required;
        plannedGeneratedQueries = plannerResult.plan.generated_queries;
      }
      const vectorQueries = mergeRecallQueries(
        explicitVectorQueries,
        vectorQueriesFromGeneratedQueries(explicitGeneratedQueries),
        vectorQueriesFromGeneratedQueries(plannedGeneratedQueries),
      );
      const evidencePolicy = strategies.length > 0 || evidenceRequired.length > 0
        ? {
          strategies,
          evidenceRequired,
          retrievalPlan: strategies.length > 0 || evidenceRequired.length > 0
            ? {
              strategies,
              evidence_required: evidenceRequired,
            }
            : undefined,
        }
        : undefined;
      const honorVectorOptOut = shouldHonorRecallVectorOptOut({
        includeVector: call.args.include_vector,
        strategies,
        evidenceRequired,
      });
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
          vectorTimeoutMs: input.memoryVectorTimeoutMs ?? RECALL_MEMORY_TOOL_VECTOR_TIMEOUT_MS,
        });
      return {
        ok: true,
        ...recall,
        diagnostics: [
          ...recall.diagnostics,
          ...(call.args.include_vector === false && !honorVectorOptOut
            ? ["vector=forced:model-opt-out-ignored"]
            : []),
          ...retrievalPlannerDiagnostics(plannerResult),
        ],
      };
    },
    "query_memory": async (call: ToolCall) => {
      const scope = call.args.scope === "session" ? "session" : "all_sessions";
      const sessionId = typeof call.args.session_id === "string" && call.args.session_id.trim()
        ? call.args.session_id.trim()
        : input.sessionId;
      return {
        ok: true,
        ...queryMemory({
          butlerData: input.butlerData,
          appMessageDbPath: input.appMessageDbPath,
          query: typeof call.args.query === "string" ? call.args.query : undefined,
          scope,
          sessionId,
          speaker: call.args.speaker === "user" || call.args.speaker === "butler" ? call.args.speaker : "any",
          eventKind: call.args.event_kind === "inbound" || call.args.event_kind === "outbound"
            ? call.args.event_kind
            : "any",
          order: call.args.order === "latest" ? "latest" : "earliest",
          matchMode: call.args.match_mode === "all" || call.args.match_mode === "phrase"
            ? call.args.match_mode
            : "any",
          limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
          dateFrom: typeof call.args.date_from === "string" ? call.args.date_from : undefined,
          dateTo: typeof call.args.date_to === "string" ? call.args.date_to : undefined,
          includeInternal: call.args.include_internal === true,
          includePlaceholders: call.args.include_placeholders === true,
        }),
      };
    },
    "summarize_user_profile": async (call: ToolCall) => {
      const locale = call.args.locale === "en" ? "en" : "ko";
      return readReflectiveProfileSummary(input.butlerData, locale);
    },
    "update_onboarding_profile": async (call: ToolCall) => {
      const personaPreset = onboardingPersonaPreset(call.args.persona_preset);
      const profilingMode = onboardingProfilingMode(call.args.profiling_mode);
      return updateFirstChatOnboarding(input.butlerData, {
        principal_name: optionalToolString(call.args.principal_name),
        preferred_address: optionalToolString(call.args.preferred_address),
        butler_nickname: optionalToolString(call.args.butler_nickname),
        interests: optionalToolString(call.args.interests),
        work: optionalToolString(call.args.work),
        service_preference: optionalToolString(call.args.service_preference),
        persona_preset: personaPreset,
        persona_custom: optionalToolString(call.args.persona_custom),
        profiling_mode: profilingMode,
        skipped_fields: Array.isArray(call.args.skipped_fields)
          ? call.args.skipped_fields.filter((item): item is string => typeof item === "string")
          : undefined,
        complete: call.args.complete === true,
        locale: call.args.locale === "en" ? "en" : "ko",
        butlerHome: input.butlerHome,
      });
    },
    "read_conversation_context": async (call: ToolCall) => {
      const direction = call.args.direction === "before" ||
        call.args.direction === "after" ||
        call.args.direction === "around"
        ? call.args.direction as ConversationContextDirection
        : undefined;
      return readConversationContext({
        sessionId: input.sessionId ?? "butler/main",
        query: typeof call.args.query === "string" ? call.args.query : undefined,
        anchorEventId: typeof call.args.anchor_event_id === "string"
          ? call.args.anchor_event_id
          : undefined,
        direction,
        limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
        maxChars: typeof call.args.max_chars === "number" ? call.args.max_chars : undefined,
      });
    },
    "update_explicit_memory": async (call: ToolCall) => {
      const kind = typeof call.args.kind === "string" ? call.args.kind.trim() : "";
      if (kind !== "rule") {
        throw new Error("update_explicit_memory requires kind rule");
      }
      const text = typeof call.args.text === "string" ? call.args.text.trim() : "";
      const source = typeof call.args.source === "string" ? call.args.source.trim() : "";
      if (!text) throw new Error("update_explicit_memory requires text");
      if (!source) throw new Error("update_explicit_memory requires source");
      return updateExplicitMemory({
        butlerData: input.butlerData,
        update: {
          kind,
          text,
          source,
        },
      });
    },
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRecallEnumArray<T extends string>(value: unknown, allowed: Set<T>): T[] {
  if (!Array.isArray(value)) return [];
  const output: T[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item as T) || output.includes(item as T)) continue;
    output.push(item as T);
  }
  return output;
}

function normalizeRecallGeneratedQueries(value: unknown): RetrievalGeneratedQuery[] {
  if (!Array.isArray(value)) return [];
  const output: RetrievalGeneratedQuery[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const strategy = typeof raw.strategy === "string" &&
      RECALL_RETRIEVAL_STRATEGIES.has(raw.strategy as RetrievalStrategy)
      ? raw.strategy as RetrievalStrategy
      : null;
    const query = typeof raw.query === "string" ? raw.query.trim() : "";
    if (!strategy || query.length < 2) continue;
    const key = strategy + ":" + query.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ strategy, query });
  }
  return output;
}

function shouldHonorRecallVectorOptOut(input: {
  includeVector: unknown;
  strategies: RetrievalStrategy[];
  evidenceRequired: RetrievalEvidenceRequirement[];
}): boolean {
  if (input.includeVector !== false) return false;
  return input.strategies.includes("query_exact_transcript") ||
    input.evidenceRequired.includes("exact_quote");
}

function mergeRecallQueries(...groups: Array<string[] | undefined>): string[] | undefined {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const value of group ?? []) {
      const query = value.trim();
      if (query.length < 2) continue;
      const key = query.toLocaleLowerCase("en-US");
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(query);
    }
  }
  return output.length > 0 ? output : undefined;
}

function vectorQueriesFromGeneratedQueries(queries: RetrievalGeneratedQuery[]): string[] {
  return queries
    .filter((query) => query.strategy === "search_vector_episode")
    .map((query) => query.query);
}

function retrievalPlannerDiagnostics(result: RetrievalPlanningResult | null): string[] {
  if (!result) return [];
  return [
    "retrieval_planner=used",
    "retrieval_planner_attempts=" + result.attempts,
    ...result.diagnostics.map((entry) => "retrieval_planner_" + entry),
    ...(result.fallbackReason ? ["retrieval_planner_fallback=" + result.fallbackReason] : []),
  ];
}

function optionalToolString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function onboardingPersonaPreset(value: unknown): FirstChatOnboardingPersonaPreset | "custom" | undefined {
  if (value === "custom") return "custom";
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function onboardingProfilingMode(value: unknown): ProfilingMode | undefined {
  return value === "off" || value === "basic" || value === "deep" ? value : undefined;
}
