import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { runPromptText } from "../providers/provider.ts";
export type SearchDepth = "quick" | "balanced" | "deep" | "verification";
export type SearchScope =
  | "single_topic"
  | "multi_domain"
  | "comparison"
  | "verification"
  | "unknown";
export type SearchQueryPurpose =
  | "scan"
  | "curation"
  | "validation"
  | "official"
  | "reaction"
  | "comparison";
export type SearchPriority = "low" | "normal" | "high";
export type ExpectedSourceType =
  | "official"
  | "news"
  | "curation"
  | "community"
  | "review"
  | "docs";

export interface SearchBucket {
  id: string;
  label: string;
  reason: string;
  priority: SearchPriority;
}

export interface SearchQueryPlan {
  bucketId?: string;
  query: string;
  purpose: SearchQueryPurpose;
  priority: SearchPriority;
  expectedSourceType?: ExpectedSourceType;
}

export interface SearchPlan {
  mode: "smart";
  depth: SearchDepth;
  originalRequest: string;
  intent: string;
  scope: SearchScope;
  decomposition: SearchBucket[];
  queries: SearchQueryPlan[];
  parallelizable: boolean;
  verificationRequired: boolean;
  notes?: string[];
}

export interface SearchPlanningConfig {
  enabled: boolean;
  defaultDepth: Exclude<SearchDepth, "verification">;
  timezone: string;
  model?: string;
}

export interface SmartSearchPlanningInput {
  butlerData: string;
  query: string;
  originalRequest?: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
  recencyDays?: number;
  maxResults?: number;
  now?: Date;
  model?: string;
  runPrompt?: SmartSearchPlannerRunner;
}

export interface SmartSearchPlanningResult {
  plan: SearchPlan | null;
  usedPlanner: boolean;
  attempts: number;
  fallbackReason?: string;
}

export type SmartSearchPlannerRunner = (input: {
  prompt: string;
  instructions: string;
  model?: string;
}) => Promise<string>;

const MAX_PLANNED_QUERIES: Record<SearchDepth, number> = {
  quick: 4,
  balanced: 6,
  deep: 8,
  verification: 6,
};

export function readSearchPlanningConfig(
  butlerData: string,
): SearchPlanningConfig {
  const configPath = join(butlerData, "butler.config.json");
  let raw: Record<string, any> = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
    } catch {
      raw = {};
    }
  }
  const webSearch = raw.webSearch ?? {};
  const planning = webSearch.planning ?? {};
  const timezone =
    typeof raw.user?.timezone === "string" && raw.user.timezone.trim()
      ? raw.user.timezone.trim()
      : process.env.TZ ||
        Intl.DateTimeFormat().resolvedOptions().timeZone ||
        "UTC";
  const defaultDepth =
    planning.defaultDepth === "quick" || planning.defaultDepth === "deep"
      ? planning.defaultDepth
      : "balanced";
  return {
    enabled:
      planning.mode === "off"
        ? false
        : typeof planning.enabled === "boolean"
          ? planning.enabled
          : true,
    defaultDepth,
    timezone,
    model:
      typeof webSearch.model === "string" && webSearch.model.trim()
        ? webSearch.model.trim()
        : undefined,
  };
}

export async function createSmartSearchPlan(
  input: SmartSearchPlanningInput,
): Promise<SmartSearchPlanningResult> {
  const config = readSearchPlanningConfig(input.butlerData);
  const model = input.model ?? config.model;
  if (!config.enabled) {
    return {
      plan: null,
      usedPlanner: false,
      attempts: 0,
      fallbackReason: "search planning is disabled",
    };
  }
  const runPrompt = input.runPrompt ?? defaultPlannerRunner;
  const instructions = buildSmartSearchPlanningInstructions();
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = buildSmartSearchPlanningPrompt({
      ...input,
      attempt,
      config,
      parseError: lastError,
    });
    try {
      const text = await runPrompt({ prompt, instructions, model });
      const plan = normalizeSearchPlan(
        parsePlannerJson(text),
        effectiveOriginalRequest(input),
        config,
      );
      return {
        plan,
        usedPlanner: true,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    plan: null,
    usedPlanner: true,
    attempts: 2,
    fallbackReason: lastError || "planner returned invalid JSON",
  };
}

export function buildSmartSearchPlanningInstructions(): string {
  return [
    "You are Butler's Smart Search Planning layer.",
    "Plan web search queries before the actual search provider is called.",
    "Use the original user request or current-turn context as the primary source for intent, scope, depth, risk, and decomposition when it is provided.",
    "Use the model-selected web_search query as a retrieval seed, not as a replacement for the original request.",
    "If the model-selected query collapses multiple user-named subjects or drops speed, depth, evidence, or risk signals, recover those signals from the original request.",
    "Use the user's language for queries when that language is likely to reach the best sources.",
    "Use the target source language or English when those are more likely to find authoritative sources.",
    "If localized user-language sources and official/global source-language sources are both useful, create separate language/source lanes instead of mixing both languages into one provider query.",
    "Do not combine localized entity names, user-language media terms, and international or English source anchors in the same query unless one is only a short alias that does not overload retrieval.",
    "Prefer one query in the user's language or localized naming for local/user-language sources, and a separate query in the official, global, or source language for official or international sources.",
    "Choose quick when the user asks for a fast, brief, lightweight, or high-level search.",
    "Choose deep when the user asks for careful research, evidence, sources, comparison, risks, or completeness.",
    "Choose verification when the answer depends on current factual status, primary-source confirmation, or could materially affect a consequential real-world decision.",
    "Do not over-decompose. Split only when separate queries or source types are genuinely useful.",
    "Each query should have one clear retrieval job and should be useful as-is in a normal web search engine.",
    "Do not merely paraphrase the user request as a query; construct search-engine-native keyword queries.",
    "For each query, use the fewest lexical anchors that can retrieve the target evidence.",
    "Prefer exact entity names, product names, ticker symbols, source names, page names, or source-class anchors over vague intent words.",
    "Avoid vague intent words such as important, evidence, official, recommendation, quick, or their equivalents unless those words are likely literal source terms.",
    "Separate scan, official or primary-source, review, comparison, risk, reaction, and verification retrieval jobs instead of mixing them in one query.",
    "For high-risk verification, keep each query narrow: one claim, entity, source surface, or safety question per query.",
    "For high-risk verification, prefer primary-source, regulatory, official-label, standards, clinical-guidance, legal-text, disclosure, or incident-report source surfaces over broad SEO-style summaries.",
    "For official, regulatory, legal, disclosure, label, or standards queries, target the issuing organization or stable host/page surface plus the entity, filing, label, or claim; do not rely only on generic source acronyms or third-party summaries.",
    "For high-risk source choice, do not let the user's language or locale exclude stronger authoritative guidance in another source language.",
    "When you intentionally target a named source, use a stable source/page/domain-style anchor if known and useful; otherwise avoid ambiguous source names that search engines may satisfy with unrelated blogs or mirrors.",
    "Avoid dynamic map, internal search-result, or app-shell pages as evidence targets unless the user explicitly asks for that service; prefer indexable local guides, official pages, reviews, or directories that can be read.",
    "Use dates only when they improve retrieval for news, events, releases, or time-bounded claims; avoid injecting a full current date into evergreen, official, review, or product-comparison queries.",
    "If no concrete entity or source is known for an official query, do not invent a generic official-blog or official-announcement query; use authoritative scan or curation sources first.",
    "Prefer broad curated or authoritative sources for quick scans, and include validation-oriented or official-source queries for deep or verification work.",
    "For broad briefing requests, use the smallest useful decomposition and prefer source-seeking curated or authoritative overview queries over many narrow topic buckets.",
    "When a query is meant to use curation, name an appropriate curated source, newswire, aggregator, official index, or publication in the query instead of using only generic topic words.",
    "For local/domestic briefing scope, infer suitable overview sources from the user's locale and language; for international/global scope, infer suitable global overview sources.",
    "For requests that combine multiple subjects with evidence/source signals, split by the subjects the user named, mark depth deep, make the plan parallelizable, and include validation-oriented queries.",
    "For consequential decision-support questions, ignore speed shortcuts: choose verification, infer the evidence dimensions needed for that specific subject, separate those dimensions into focused queries, and avoid verdict-seeking query phrasing.",
    "For consequential decision-support, include separate searches for current state, primary-source facts, and independent analysis or risk when those dimensions are relevant.",
    "For rankings, candidates, or discovery tasks, include at least one source-discovery query for the official table, dataset, or curated source itself before queries that name likely answers.",
    "If the request contains a date, period, version, release window, or other temporal constraint, preserve that exact constraint in the planned queries and prefer official or primary sources.",
    "Avoid topic-soup queries that merely concatenate many section labels, avoid fragile search operators such as wildcard site: patterns, and avoid overloading one query with too many source names.",
    "Return only one valid JSON object matching the requested schema.",
  ].join("\n");
}

export function buildSmartSearchPlanningPrompt(input: {
  query: string;
  originalRequest?: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
  recencyDays?: number;
  maxResults?: number;
  now?: Date;
  attempt: number;
  config: SearchPlanningConfig;
  parseError?: string;
}): string {
  const now = input.now ?? new Date();
  const currentDate = formatDateInTimeZone(now, input.config.timezone);
  const retry = input.attempt > 1
    ? `\nPrevious response was invalid: ${input.parseError || "invalid JSON/schema"}. Return corrected JSON only.`
    : "";
  const originalRequest = effectiveOriginalRequest(input);
  return `Plan web searches for the request below.

Original user request or bounded current-turn context:
${JSON.stringify(originalRequest)}

Model-selected web_search query:
${JSON.stringify(input.query)}

Use the original user request/context for intent, scope, depth, and decomposition. Use the model-selected web_search query only as a retrieval seed or hint. If the seed query lost separate user-named subjects or omitted evidence/source/depth/risk/speed signals, restore those from the original request/context.

Runtime context:
${JSON.stringify({
    currentDate,
    timeZone: input.config.timezone,
    defaultDepth: input.config.defaultDepth,
    plannedQueryExecution: "parallel",
    allowedDomains: input.allowedDomains ?? [],
    blockedDomains: input.blockedDomains ?? [],
    recencyDays: input.recencyDays ?? null,
    maxResults: input.maxResults ?? null,
  }, null, 2)}

Return JSON with this exact shape:
{
  "depth": "quick" | "balanced" | "deep" | "verification",
  "originalRequest": string,
  "intent": string,
  "scope": "single_topic" | "multi_domain" | "comparison" | "verification" | "unknown",
  "decomposition": [
    {
      "id": string,
      "label": string,
      "reason": string,
      "priority": "low" | "normal" | "high"
    }
  ],
  "queries": [
    {
      "bucketId": string,
      "query": string,
      "purpose": "scan" | "curation" | "validation" | "official" | "reaction" | "comparison",
      "priority": "low" | "normal" | "high",
      "expectedSourceType": "official" | "news" | "curation" | "community" | "review" | "docs"
    }
  ],
  "verificationRequired": boolean,
  "notes": string[]
}

Constraints:
- Generate at most ${Math.max(3, input.maxResults ?? 6)} query candidates, and avoid near-duplicates.
- A simple single-topic request can have one bucket and one query.
- Each query should have one clear retrieval job.
- Do not paraphrase the user request as a query; write search-engine-native keyword queries.
- For every query, choose minimal lexical anchors for the evidence target.
- Include exact entity, product, ticker, organization, source, page, or source-class anchors when known.
- Avoid vague intent words such as important, evidence, official, recommendation, quick, or their equivalents unless they are likely literal source terms.
- Separate scan, official/primary-source, review, comparison, risk, reaction, and verification jobs into different queries.
- For high-risk verification, keep each query narrow: one claim, entity, source surface, or safety question per query.
- For high-risk verification, prefer primary-source, regulatory, official-label, standards, clinical-guidance, legal-text, disclosure, or incident-report source surfaces over broad SEO-style summaries.
- For official, regulatory, legal, disclosure, label, or standards queries, target the issuing organization or stable host/page surface plus the entity, filing, label, or claim; do not rely only on generic source acronyms or third-party summaries.
- For high-risk source choice, do not let the user's language or locale exclude stronger authoritative guidance in another source language.
- When intentionally targeting a named source, use a stable source/page/domain-style anchor if known and useful; otherwise avoid ambiguous source names that search engines may satisfy with unrelated blogs or mirrors.
- Avoid dynamic map, internal search-result, or app-shell pages as evidence targets unless the user explicitly asks for that service; prefer indexable local guides, official pages, reviews, or directories that can be read.
- Use dates only when they improve retrieval; avoid full current dates for evergreen official pages, product reviews, or general comparisons.
- If the plan lacks a concrete entity/source for an official query, do not invent generic official blog or official announcement queries. Use authoritative scan or curation queries first, then let later result reading identify official sources.
- Do not keep multiple user-named subjects in the same provider query when they need separate source surfaces or validation paths.
- If localized user-language sources and official/global source-language sources are both useful, split them into separate query lanes.
- Do not combine localized entity names, user-language media terms, and international or English source anchors in one provider query unless one is only a short alias.
- Prefer one query in the user's language or localized naming for local/user-language sources, and a separate query in the official, global, or source language for official or international sources.
- Broad briefing requests should usually stay at quick or balanced depth with 2-4 curated or authoritative overview queries unless the user asks for deeper analysis.
- Prefer source-seeking overview queries over topic-soup queries that concatenate many generic sections.
- Curation-purpose queries should name a suitable source or source category inferred from the user's locale, language, and target scope; do not hardcode a fixed source list.
- Requests that combine multiple named subjects with evidence/source wording should use deep depth, separate those subjects, and include validation-oriented queries.
- Consequential decision-support requests must use verification depth even when the user asks for a quick answer.
- For verification plans, infer the evidence dimensions that matter for the specific subject instead of relying on a fixed domain checklist, and avoid verdict-seeking query phrasing.
- For consequential decision-support, keep current state, primary-source facts, and independent analysis or risk in separate queries when those dimensions are relevant.
- Discovery tasks should not bake assumed answers into every query; include a query for the source table, dataset, official announcement, or curated source itself.
- Preserve explicit temporal constraints exactly when present.
- Avoid fragile or provider-specific search syntax, including wildcard site: operators.
- If depth is "deep" or "verification", set verificationRequired to true.
- If allowedDomains are present, keep queries compatible with those domains.
- If blockedDomains are present, do not target those domains.
- Do not include markdown, code fences, or explanatory prose.${retry}`;
}

function effectiveOriginalRequest(input: {
  query: string;
  originalRequest?: string;
}): string {
  const original = input.originalRequest?.trim();
  return original || input.query;
}

function formatDateInTimeZone(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Fall through to UTC formatting.
  }
  return date.toISOString().slice(0, 10);
}

function parsePlannerJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  const body = fenced?.[1]?.trim() ?? trimmed;
  return JSON.parse(body);
}

function normalizeSearchPlan(
  raw: unknown,
  originalRequest: string,
  config: SearchPlanningConfig,
): SearchPlan {
  if (!raw || typeof raw !== "object") throw new Error("plan is not an object");
  const value = raw as Record<string, any>;
  const depth = normalizeDepth(value.depth, config.defaultDepth);
  const queries = normalizeQueries(value.queries, depth);
  if (queries.length === 0) throw new Error("plan has no queries");
  const buckets = normalizeBuckets(value.decomposition);
  const scope = normalizeScope(value.scope);
  const verificationRequired =
    value.verificationRequired === true ||
    depth === "deep" ||
    depth === "verification";
  return {
    mode: "smart",
    depth,
    originalRequest,
    intent:
      typeof value.intent === "string" && value.intent.trim()
        ? value.intent.trim().slice(0, 160)
        : "web_search",
    scope,
    decomposition: buckets,
    queries,
    parallelizable:
      true,
    verificationRequired,
    notes: Array.isArray(value.notes)
      ? value.notes
        .filter((note) => typeof note === "string" && note.trim())
        .map((note) => note.trim().slice(0, 240))
        .slice(0, 5)
      : undefined,
  };
}

function normalizeDepth(
  value: unknown,
  fallback: SearchPlanningConfig["defaultDepth"],
): SearchDepth {
  if (
    value === "quick" ||
    value === "balanced" ||
    value === "deep" ||
    value === "verification"
  ) return value;
  return fallback;
}

function normalizeScope(value: unknown): SearchScope {
  if (
    value === "single_topic" ||
    value === "multi_domain" ||
    value === "comparison" ||
    value === "verification" ||
    value === "unknown"
  ) return value;
  return "unknown";
}

function normalizeBuckets(value: unknown): SearchBucket[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const raw = item as Record<string, any>;
      const label = typeof raw.label === "string" ? raw.label.trim() : "";
      if (!label) return null;
      return {
        id:
          typeof raw.id === "string" && raw.id.trim()
            ? safeId(raw.id)
            : `bucket_${index + 1}`,
        label: label.slice(0, 80),
        reason:
          typeof raw.reason === "string" && raw.reason.trim()
            ? raw.reason.trim().slice(0, 180)
            : "Planned search bucket",
        priority: normalizePriority(raw.priority),
      };
    })
    .filter((item): item is SearchBucket => Boolean(item))
    .slice(0, 8);
}

function normalizeQueries(value: unknown, depth: SearchDepth): SearchQueryPlan[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: SearchQueryPlan[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, any>;
    const query = typeof raw.query === "string" ? raw.query.trim() : "";
    if (query.length < 2) continue;
    const key = query.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      bucketId:
        typeof raw.bucketId === "string" && raw.bucketId.trim()
          ? safeId(raw.bucketId)
          : undefined,
      query: query.slice(0, 220),
      purpose: normalizePurpose(raw.purpose),
      priority: normalizePriority(raw.priority),
      expectedSourceType: normalizeExpectedSourceType(raw.expectedSourceType),
    });
    if (output.length >= MAX_PLANNED_QUERIES[depth]) break;
  }
  return output;
}

function normalizePurpose(value: unknown): SearchQueryPurpose {
  if (
    value === "scan" ||
    value === "curation" ||
    value === "validation" ||
    value === "official" ||
    value === "reaction" ||
    value === "comparison"
  ) return value;
  return "scan";
}

function normalizePriority(value: unknown): SearchPriority {
  if (value === "low" || value === "high") return value;
  return "normal";
}

function normalizeExpectedSourceType(
  value: unknown,
): ExpectedSourceType | undefined {
  if (
    value === "official" ||
    value === "news" ||
    value === "curation" ||
    value === "community" ||
    value === "review" ||
    value === "docs"
  ) return value;
  return undefined;
}

function safeId(value: string): string {
  const id = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return id || "bucket";
}

async function defaultPlannerRunner(input: {
  prompt: string;
  instructions: string;
  model?: string;
}): Promise<string> {
  return await runPromptText({
    prompt: input.prompt,
    instructions: input.instructions,
    model: input.model,
    cacheScope: "smart-search-planning",
  });
}
