import { runPromptText } from "../../../integrations/providers/provider.ts";

export type RetrievalMissingReferent =
  | "target"
  | "time_window"
  | "prior_decision"
  | "active_task"
  | "artifact"
  | "project_context";

export type RetrievalStrategy =
  | "read_recent_context"
  | "query_exact_transcript"
  | "search_lexical_memory"
  | "search_vector_episode"
  | "read_graph_memory"
  | "read_explicit_memory"
  | "read_task_state";

export type RetrievalEvidenceRequirement =
  | "exact_quote"
  | "recent_turn_hit"
  | "task_continuity"
  | "project_memory_hit"
  | "vector_episode_hit"
  | "explicit_rule_hit"
  | "graph_relation_hit";

export interface RetrievalGeneratedQuery {
  strategy: RetrievalStrategy;
  query: string;
}

export interface RetrievalPlan {
  self_sufficient: boolean;
  missing_referents: RetrievalMissingReferent[];
  strategies: RetrievalStrategy[];
  generated_queries: RetrievalGeneratedQuery[];
  evidence_required: RetrievalEvidenceRequirement[];
  max_latency_ms?: number;
}

export type RetrievalPlannerRunner = (input: {
  prompt: string;
  instructions: string;
  model?: string;
}) => Promise<string>;

export interface RetrievalPlanningInput {
  request: string;
  recentContext?: string;
  activeTaskSummary?: string;
  projectId?: string;
  sessionId?: string;
  now?: Date;
  model?: string;
  maxLatencyMs?: number;
  runPrompt?: RetrievalPlannerRunner;
}

export interface RetrievalPlanningResult {
  plan: RetrievalPlan;
  usedPlanner: boolean;
  attempts: number;
  fallbackReason?: string;
  diagnostics: string[];
}

const PLANNER_ATTEMPTS = 2;
const DEFAULT_PLANNER_TIMEOUT_MS = 1500;
const DEFAULT_MAX_LATENCY_MS = 900;

const MISSING_REFERENTS = new Set<RetrievalMissingReferent>([
  "target",
  "time_window",
  "prior_decision",
  "active_task",
  "artifact",
  "project_context",
]);

const STRATEGIES = new Set<RetrievalStrategy>([
  "read_recent_context",
  "query_exact_transcript",
  "search_lexical_memory",
  "search_vector_episode",
  "read_graph_memory",
  "read_explicit_memory",
  "read_task_state",
]);

const EVIDENCE_REQUIREMENTS = new Set<RetrievalEvidenceRequirement>([
  "exact_quote",
  "recent_turn_hit",
  "task_continuity",
  "project_memory_hit",
  "vector_episode_hit",
  "explicit_rule_hit",
  "graph_relation_hit",
]);

const FALLBACK_STRATEGIES: RetrievalStrategy[] = [
  "read_recent_context",
  "query_exact_transcript",
  "search_lexical_memory",
  "read_graph_memory",
  "read_explicit_memory",
  "read_task_state",
  "search_vector_episode",
];

export async function createRetrievalPlan(
  input: RetrievalPlanningInput,
): Promise<RetrievalPlanningResult> {
  const runPrompt = input.runPrompt ?? defaultRetrievalPlannerRunner;
  const instructions = buildRetrievalPlanningInstructions();
  const maxLatencyMs = normalizeLatencyMs(input.maxLatencyMs, DEFAULT_PLANNER_TIMEOUT_MS);
  let lastError = "";

  for (let attempt = 1; attempt <= PLANNER_ATTEMPTS; attempt += 1) {
    const prompt = buildRetrievalPlanningPrompt({
      ...input,
      attempt,
      parseError: lastError,
    });
    try {
      const text = await withTimeout(
        runPrompt({ prompt, instructions, model: input.model }),
        maxLatencyMs,
        "retrieval planner timed out",
      );
      const plan = normalizeRetrievalPlan(parsePlannerJson(text), input);
      return {
        plan,
        usedPlanner: true,
        attempts: attempt,
        diagnostics: [`planner_succeeded_attempt_${attempt}`],
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    plan: buildFallbackRetrievalPlan(input),
    usedPlanner: true,
    attempts: PLANNER_ATTEMPTS,
    fallbackReason: lastError || "planner returned invalid JSON",
    diagnostics: ["planner_failed", "using_conservative_fallback"],
  };
}

export function buildFallbackRetrievalPlan(input: {
  request: string;
  maxLatencyMs?: number;
}): RetrievalPlan {
  const query = compact(input.request, 240) || "current conversation";
  return {
    self_sufficient: false,
    missing_referents: ["target"],
    strategies: [...FALLBACK_STRATEGIES],
    generated_queries: FALLBACK_STRATEGIES
      .filter((strategy) => strategy !== "read_recent_context" && strategy !== "read_task_state")
      .map((strategy) => ({ strategy, query })),
    evidence_required: [
      "recent_turn_hit",
      "exact_quote",
      "project_memory_hit",
      "graph_relation_hit",
      "explicit_rule_hit",
      "task_continuity",
      "vector_episode_hit",
    ],
    max_latency_ms: normalizeLatencyMs(input.maxLatencyMs, DEFAULT_MAX_LATENCY_MS),
  };
}

export function buildRetrievalPlanningInstructions(): string {
  return [
    "You are Butler's retrieval planning layer.",
    "Select local retrieval strategies before memory tools or memory stores are read.",
    "Decide by referential completeness: whether the target, operation, evidence type, time window, project, task, or artifact can be identified from the current message and bounded context.",
    "Do not classify by fixed word lists, stopwords, pronoun lists, temporal-adverb lists, particles, or language-specific dictionaries.",
    "Do not expose hidden reasoning. Return only the structured plan, generated retrieval queries, and evidence requirements.",
    "Choose exact transcript lookup only when exact wording, dates, counts, first/last, speaker, or chronological proof is needed.",
    "Choose associative memory strategies when durable decisions, preferences, task outcomes, graph relations, explicit rules, project memory, or semantic episode recall are needed.",
    "Choose recent context or task state when the current message is not self-contained.",
    "Use vector episode search only as semantic episode recall, not as a replacement for exact transcript evidence.",
    "If evidence looks weak, plan additional local retrieval paths before asking the user.",
    "Return only one valid JSON object matching the requested schema.",
  ].join("\n");
}

export function buildRetrievalPlanningPrompt(input: RetrievalPlanningInput & {
  attempt: number;
  parseError?: string;
}): string {
  const retry = input.attempt > 1
    ? `\nPrevious response was invalid: ${input.parseError || "invalid JSON/schema"}. Return corrected JSON only.`
    : "";
  return `Plan Butler local memory retrieval for this turn.

Current user message:
${JSON.stringify(compact(input.request, 1200))}

Bounded recent context:
${JSON.stringify(compact(input.recentContext ?? "", 1600))}

Active task summary:
${JSON.stringify(compact(input.activeTaskSummary ?? "", 800))}

Runtime metadata:
${JSON.stringify({
    now: (input.now ?? new Date()).toISOString(),
    projectId: input.projectId ?? null,
    sessionId: input.sessionId ?? null,
    maxLatencyMs: normalizeLatencyMs(input.maxLatencyMs, DEFAULT_MAX_LATENCY_MS),
  }, null, 2)}

Return JSON with this exact shape:
{
  "self_sufficient": boolean,
  "missing_referents": ["target" | "time_window" | "prior_decision" | "active_task" | "artifact" | "project_context"],
  "strategies": ["read_recent_context" | "query_exact_transcript" | "search_lexical_memory" | "search_vector_episode" | "read_graph_memory" | "read_explicit_memory" | "read_task_state"],
  "generated_queries": [
    {
      "strategy": "read_recent_context" | "query_exact_transcript" | "search_lexical_memory" | "search_vector_episode" | "read_graph_memory" | "read_explicit_memory" | "read_task_state",
      "query": string
    }
  ],
  "evidence_required": ["exact_quote" | "recent_turn_hit" | "task_continuity" | "project_memory_hit" | "vector_episode_hit" | "explicit_rule_hit" | "graph_relation_hit"],
  "max_latency_ms": number
}

Constraints:
- Judge self_sufficient from whether the request's target and requested operation are identifiable from the current message plus bounded context.
- Do not decide by matching fixed phrases or language-specific dictionary entries.
- Include only strategies that can produce relevant local evidence.
- Put retrieval-ready queries in generated_queries for strategies that need a query.
- If exact wording, dates, counts, first/last, speaker, or chronological proof is needed, include query_exact_transcript and exact_quote.
- If current context is incomplete, include read_recent_context and any relevant task or project strategy.
- If durable preferences, corrections, or user rules matter, include read_explicit_memory and explicit_rule_hit.
- If prior task/work continuity matters, include read_task_state and task_continuity.
- If semantic episode recall may help and exact transcript evidence is not the primary requirement, include search_vector_episode and vector_episode_hit.
- Use search_lexical_memory for cheap lexical recall, but never treat it as semantic evidence.
- Keep max_latency_ms between 200 and 10000.
- Do not include markdown, code fences, or explanatory prose.${retry}`;
}

export function normalizeRetrievalPlan(
  raw: unknown,
  fallbackInput: { request: string; maxLatencyMs?: number },
): RetrievalPlan {
  if (!raw || typeof raw !== "object") throw new Error("plan is not an object");
  const value = raw as Record<string, any>;
  const strategies = normalizeEnumArray(value.strategies, STRATEGIES, 12);
  if (strategies.length === 0) throw new Error("plan has no strategies");
  const selfSufficient = value.self_sufficient === true;
  const missingReferents = selfSufficient
    ? normalizeEnumArray(value.missing_referents, MISSING_REFERENTS, 6)
    : normalizeEnumArray(value.missing_referents, MISSING_REFERENTS, 6, ["target"]);
  const generatedQueries = normalizeGeneratedQueries(value.generated_queries, strategies);
  const evidenceRequired = normalizeEnumArray(
    value.evidence_required,
    EVIDENCE_REQUIREMENTS,
    10,
    inferEvidenceRequirements(strategies),
  );
  return {
    self_sufficient: selfSufficient,
    missing_referents: missingReferents,
    strategies,
    generated_queries: generatedQueries.length > 0
      ? generatedQueries
      : defaultGeneratedQueries(strategies, fallbackInput.request),
    evidence_required: evidenceRequired,
    max_latency_ms: normalizeLatencyMs(value.max_latency_ms, fallbackInput.maxLatencyMs ?? DEFAULT_MAX_LATENCY_MS),
  };
}

function parsePlannerJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  const body = fenced?.[1]?.trim() ?? trimmed;
  return JSON.parse(body);
}

function normalizeGeneratedQueries(
  value: unknown,
  selectedStrategies: RetrievalStrategy[],
): RetrievalGeneratedQuery[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set(selectedStrategies);
  const seen = new Set<string>();
  const output: RetrievalGeneratedQuery[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, any>;
    const strategy = typeof raw.strategy === "string" && STRATEGIES.has(raw.strategy as RetrievalStrategy)
      ? raw.strategy as RetrievalStrategy
      : null;
    const query = typeof raw.query === "string" ? compact(raw.query, 240) : "";
    if (!strategy || !selected.has(strategy) || query.length < 2) continue;
    const key = `${strategy}:${query.toLocaleLowerCase("en-US")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ strategy, query });
    if (output.length >= 12) break;
  }
  return output;
}

function defaultGeneratedQueries(
  strategies: RetrievalStrategy[],
  request: string,
): RetrievalGeneratedQuery[] {
  const query = compact(request, 240);
  if (query.length < 2) return [];
  return strategies
    .filter((strategy) => strategy !== "read_recent_context" && strategy !== "read_task_state")
    .map((strategy) => ({ strategy, query }));
}

function inferEvidenceRequirements(
  strategies: RetrievalStrategy[],
): RetrievalEvidenceRequirement[] {
  const evidence = new Set<RetrievalEvidenceRequirement>();
  for (const strategy of strategies) {
    if (strategy === "read_recent_context") evidence.add("recent_turn_hit");
    if (strategy === "query_exact_transcript") evidence.add("exact_quote");
    if (strategy === "search_lexical_memory") evidence.add("project_memory_hit");
    if (strategy === "search_vector_episode") evidence.add("vector_episode_hit");
    if (strategy === "read_graph_memory") evidence.add("graph_relation_hit");
    if (strategy === "read_explicit_memory") evidence.add("explicit_rule_hit");
    if (strategy === "read_task_state") evidence.add("task_continuity");
  }
  return [...evidence];
}

function normalizeEnumArray<T extends string>(
  value: unknown,
  allowed: Set<T>,
  limit: number,
  fallback: T[] = [],
): T[] {
  if (!Array.isArray(value)) return [...fallback];
  const output: T[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item as T) || output.includes(item as T)) continue;
    output.push(item as T);
    if (output.length >= limit) break;
  }
  return output.length > 0 ? output : [...fallback];
}

function normalizeLatencyMs(value: unknown, fallback: number): number {
  const numberValue = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(200, Math.min(10000, Math.trunc(numberValue)));
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function defaultRetrievalPlannerRunner(input: {
  prompt: string;
  instructions: string;
  model?: string;
}): Promise<string> {
  return await runPromptText({
    prompt: input.prompt,
    instructions: input.instructions,
    model: input.model,
    cacheScope: "retrieval-planning",
  });
}
