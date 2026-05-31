import { randomUUID } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { Database } from "bun:sqlite";
import { cognitionKnowHowRoot } from "../paths.ts";
import { activeFeedbackEntries } from "../feedback/buffer.ts";

export const KNOW_HOW_SCHEMA = "butler.cognition.knowhow.v1";
export const SOURCE_QUALITY_EVENT_SCHEMA = "butler.cognition.source-quality-event.v1";

export type KnowHowStatus = "candidate" | "active" | "suppressed" | "needs_review" | "disabled" | "forgotten";

export type KnowHowEntry = {
  schema: typeof KNOW_HOW_SCHEMA;
  knowhow_id: string;
  name: string;
  aliases: string[];
  status: KnowHowStatus;
  scope: string;
  created_at: string;
  updated_at: string;
  summary: string;
  intent_match: {
    topics: string[];
    examples: string[];
  };
  preconditions: string[];
  strategy: {
    steps: string[];
    preferred_sources: string[];
  };
  freshness: {
    max_age_minutes: number;
    requires_source_timestamp: boolean;
    fallback_when_stale: "try_next_source" | "generic_tool_routing";
  };
  fallback: {
    when_unavailable: "generic_tool_routing";
    when_negative_feedback: "suppress_and_review";
  };
  quality: {
    score: number;
    confidence: number;
    success_count: number;
    failure_count: number;
    negative_feedback_count: number;
    last_used_at: string | null;
    last_validated_at: string | null;
  };
  refs: {
    box_item_ids: string[];
    memory_chunk_ids: string[];
    feedback_ids: string[];
    consolidation_run_ids: string[];
  };
  revision_history: Array<Record<string, unknown>>;
};

export type SourceQualityEvent = {
  schema: typeof SOURCE_QUALITY_EVENT_SCHEMA;
  source_quality_event_id: string;
  source_id: string;
  source_uri: string;
  tool_name: string;
  observed_at: string;
  task_kind: string;
  freshness_score: number;
  success: boolean;
  latency_ms: number;
  user_feedback: "positive" | "neutral" | "negative" | "none";
  box_item_id: string | null;
  feedback_id: string | null;
  consolidation_run_id: string | null;
};

export type SourceQualitySummary = {
  source_id: string;
  tool_name: string;
  event_count: number;
  success_count: number;
  failure_count: number;
  negative_feedback_count: number;
  average_freshness_score: number;
  average_latency_ms: number;
  score: number;
  last_observed_at: string | null;
};

export type RetrieveKnowHowInput = {
  butlerData: string;
  query: string;
  scope?: string;
  limit?: number;
  now?: Date;
};

export type KnowHowCandidate = {
  entry: KnowHowEntry;
  match_score: number;
  quality_score: number;
  final_score: number;
  suppressed_by_feedback_ids: string[];
};

export type RetrieveKnowHowResult = {
  query: string;
  selected: KnowHowEntry | null;
  candidates: KnowHowCandidate[];
};

export type CreateKnowHowInput = Omit<Partial<KnowHowEntry>, "schema" | "knowhow_id" | "created_at" | "updated_at"> & {
  knowhowId?: string;
  name: string;
  summary: string;
  now?: Date;
};

function iso(date: Date = new Date()): string {
  return date.toISOString();
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function atomicWriteJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function knowHowId(): string {
  return `kh_${randomUUID()}`;
}

export function knowHowEntriesDir(butlerData: string): string {
  return join(cognitionKnowHowRoot(butlerData), "entries");
}

export function knowHowEntryPath(butlerData: string, id: string): string {
  return join(knowHowEntriesDir(butlerData), `${id}.json`);
}

export function sourceQualityPath(butlerData: string): string {
  return join(cognitionKnowHowRoot(butlerData), "source-quality.jsonl");
}

export function knowHowIndexPath(butlerData: string): string {
  return join(cognitionKnowHowRoot(butlerData), "index.sqlite");
}

export function createKnowHowEntry(butlerData: string, input: CreateKnowHowInput): KnowHowEntry {
  const now = iso(input.now);
  const entry: KnowHowEntry = {
    schema: KNOW_HOW_SCHEMA,
    knowhow_id: input.knowhowId ?? knowHowId(),
    name: input.name,
    aliases: input.aliases ?? [],
    status: input.status ?? "candidate",
    scope: input.scope ?? "global",
    created_at: now,
    updated_at: now,
    summary: input.summary,
    intent_match: input.intent_match ?? { topics: [], examples: [] },
    preconditions: input.preconditions ?? [],
    strategy: input.strategy ?? { steps: [], preferred_sources: [] },
    freshness: input.freshness ?? {
      max_age_minutes: 60,
      requires_source_timestamp: true,
      fallback_when_stale: "try_next_source",
    },
    fallback: input.fallback ?? {
      when_unavailable: "generic_tool_routing",
      when_negative_feedback: "suppress_and_review",
    },
    quality: input.quality ?? {
      score: 0.5,
      confidence: 0.5,
      success_count: 0,
      failure_count: 0,
      negative_feedback_count: 0,
      last_used_at: null,
      last_validated_at: null,
    },
    refs: input.refs ?? {
      box_item_ids: [],
      memory_chunk_ids: [],
      feedback_ids: [],
      consolidation_run_ids: [],
    },
    revision_history: input.revision_history ?? [],
  };
  writeKnowHowEntry(butlerData, entry);
  return entry;
}

export function writeKnowHowEntry(butlerData: string, entry: KnowHowEntry): void {
  const issues = validateKnowHowEntry(entry);
  if (issues.length > 0) throw new Error(`invalid know-how entry: ${issues.join("; ")}`);
  atomicWriteJson(knowHowEntryPath(butlerData, entry.knowhow_id), entry);
}

export function readKnowHowEntry(butlerData: string, id: string): KnowHowEntry | null {
  const path = knowHowEntryPath(butlerData, id);
  return existsSync(path) ? readJsonFile<KnowHowEntry>(path) : null;
}

export function listKnowHowEntries(butlerData: string): KnowHowEntry[] {
  const dir = knowHowEntriesDir(butlerData);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonFile<KnowHowEntry>(join(dir, name)))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function validateKnowHowEntry(entry: KnowHowEntry): string[] {
  const issues: string[] = [];
  if (entry.schema !== KNOW_HOW_SCHEMA) issues.push("schema must be butler.cognition.knowhow.v1");
  if (!entry.knowhow_id?.startsWith("kh_")) issues.push("knowhow_id must start with kh_");
  if (!entry.name.trim()) issues.push("name is required");
  if (!["candidate", "active", "suppressed", "needs_review", "disabled", "forgotten"].includes(entry.status)) issues.push(`invalid status: ${entry.status}`);
  if (!Array.isArray(entry.strategy?.preferred_sources)) issues.push("strategy.preferred_sources must be an array");
  return issues;
}

export function retrieveKnowHow(input: RetrieveKnowHowInput): RetrieveKnowHowResult {
  const query = normalize(input.query);
  const feedback = activeFeedbackEntries(input.butlerData, input.now);
  const candidates = listKnowHowEntries(input.butlerData)
    .filter((entry) => entry.status === "active" || entry.status === "candidate" || entry.status === "needs_review")
    .filter((entry) => !input.scope || entry.scope === "global" || entry.scope === input.scope)
    .map((entry): KnowHowCandidate => {
      const matchScore = matchKnowHow(entry, query);
      const suppressed = feedback
        .filter((item) => item.target_ref === `knowhow:${entry.knowhow_id}` ||
          entry.strategy.preferred_sources.some((source) => item.target_ref === `source:${source}`))
        .filter((item) => item.category.includes("policy") || item.category.includes("quality") || item.promotion_target.includes("know"))
        .map((item) => item.feedback_id);
      return {
        entry,
        match_score: matchScore,
        quality_score: entry.quality.score,
        final_score: suppressed.length > 0 ? 0 : Number((matchScore * 0.65 + entry.quality.score * 0.35).toFixed(3)),
        suppressed_by_feedback_ids: suppressed,
      };
    })
    .filter((candidate) => candidate.match_score > 0)
    .sort((a, b) => b.final_score - a.final_score)
    .slice(0, input.limit ?? 5);
  return {
    query: input.query,
    selected: candidates.find((candidate) => candidate.final_score > 0)?.entry ?? null,
    candidates,
  };
}

export function recordSourceQualityEvent(
  butlerData: string,
  input: Omit<SourceQualityEvent, "schema" | "source_quality_event_id"> & { sourceQualityEventId?: string },
): SourceQualityEvent {
  const event: SourceQualityEvent = {
    schema: SOURCE_QUALITY_EVENT_SCHEMA,
    source_quality_event_id: input.sourceQualityEventId ?? `sq_${randomUUID()}`,
    source_id: input.source_id,
    source_uri: input.source_uri,
    tool_name: input.tool_name,
    observed_at: input.observed_at,
    task_kind: input.task_kind,
    freshness_score: clamp01(input.freshness_score),
    success: input.success,
    latency_ms: Math.max(0, Math.trunc(input.latency_ms)),
    user_feedback: input.user_feedback,
    box_item_id: input.box_item_id,
    feedback_id: input.feedback_id,
    consolidation_run_id: input.consolidation_run_id,
  };
  ensureDir(dirname(sourceQualityPath(butlerData)));
  appendFileSync(sourceQualityPath(butlerData), `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export function listSourceQualityEvents(butlerData: string): SourceQualityEvent[] {
  const path = sourceQualityPath(butlerData);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as SourceQualityEvent];
    } catch {
      return [];
    }
  });
}

export function aggregateSourceQuality(butlerData: string): SourceQualitySummary[] {
  const groups = new Map<string, SourceQualityEvent[]>();
  for (const event of listSourceQualityEvents(butlerData)) {
    const key = `${event.tool_name}\u0000${event.source_id}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.entries()].map(([key, events]) => {
    const [toolName, sourceId] = key.split("\u0000");
    const successCount = events.filter((event) => event.success).length;
    const negativeFeedbackCount = events.filter((event) => event.user_feedback === "negative").length;
    const averageFreshness = average(events.map((event) => event.freshness_score));
    const averageLatency = average(events.map((event) => event.latency_ms));
    const successRate = events.length ? successCount / events.length : 0;
    const userFeedbackScore = events.length ? Math.max(0, 1 - negativeFeedbackCount / events.length) : 0.5;
    const latencyReliability = averageLatency <= 0 ? 1 : Math.max(0, Math.min(1, 1 - averageLatency / 10_000));
    const score = Number((
      0.30 * averageFreshness +
      0.25 * successRate +
      0.20 * userFeedbackScore +
      0.15 * 1 +
      0.10 * latencyReliability
    ).toFixed(3));
    return {
      source_id: sourceId ?? "unknown",
      tool_name: toolName ?? "unknown",
      event_count: events.length,
      success_count: successCount,
      failure_count: events.length - successCount,
      negative_feedback_count: negativeFeedbackCount,
      average_freshness_score: Number(averageFreshness.toFixed(3)),
      average_latency_ms: Number(averageLatency.toFixed(3)),
      score,
      last_observed_at: events.map((event) => event.observed_at).sort().at(-1) ?? null,
    };
  }).sort((a, b) => b.score - a.score);
}

export function rebuildKnowHowIndex(butlerData: string): { indexed_count: number; source_quality_count: number; index_path: string } {
  const root = cognitionKnowHowRoot(butlerData);
  ensureDir(root);
  const path = knowHowIndexPath(butlerData);
  const tmp = `${path}.tmp-${randomUUID()}`;
  const db = new Database(tmp, { create: true });
  try {
    db.run("CREATE TABLE knowhow_entries (knowhow_id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, scope TEXT NOT NULL, summary TEXT, score REAL NOT NULL, confidence REAL NOT NULL, updated_at TEXT NOT NULL)");
    db.run("CREATE TABLE knowhow_terms (knowhow_id TEXT NOT NULL, term TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (knowhow_id, term, kind))");
    db.run("CREATE TABLE source_quality_scores (source_id TEXT NOT NULL, tool_name TEXT NOT NULL, score REAL NOT NULL, event_count INTEGER NOT NULL, negative_feedback_count INTEGER NOT NULL, last_observed_at TEXT, PRIMARY KEY (source_id, tool_name))");
    db.run("CREATE INDEX idx_knowhow_entries_status ON knowhow_entries(status)");
    db.run("CREATE INDEX idx_knowhow_terms_term ON knowhow_terms(term)");
    const insertEntry = db.query("INSERT INTO knowhow_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const insertTerm = db.query("INSERT OR IGNORE INTO knowhow_terms VALUES (?, ?, ?)");
    let indexed = 0;
    for (const entry of listKnowHowEntries(butlerData)) {
      const issues = validateKnowHowEntry(entry);
      if (issues.length > 0) continue;
      insertEntry.run(entry.knowhow_id, entry.name, entry.status, entry.scope, entry.summary, entry.quality.score, entry.quality.confidence, entry.updated_at);
      for (const [kind, values] of Object.entries(termsForEntry(entry))) {
        for (const value of values) insertTerm.run(entry.knowhow_id, value, kind);
      }
      indexed += 1;
    }
    const insertQuality = db.query("INSERT INTO source_quality_scores VALUES (?, ?, ?, ?, ?, ?)");
    const quality = aggregateSourceQuality(butlerData);
    for (const summary of quality) {
      insertQuality.run(summary.source_id, summary.tool_name, summary.score, summary.event_count, summary.negative_feedback_count, summary.last_observed_at);
    }
    db.close();
    renameSync(tmp, path);
    return { indexed_count: indexed, source_quality_count: quality.length, index_path: path };
  } catch (error) {
    db.close();
    throw error;
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function tokenize(value: string): Set<string> {
  return new Set(normalize(value).split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length >= 2));
}

function matchKnowHow(entry: KnowHowEntry, query: string): number {
  const queryTokens = tokenize(query);
  const buckets = [
    [entry.name, 1],
    ...entry.aliases.map((value) => [value, 0.95] as const),
    ...entry.intent_match.topics.map((value) => [value, 0.8] as const),
    ...entry.intent_match.examples.map((value) => [value, 0.65] as const),
    [entry.summary, 0.35] as const,
  ] as Array<readonly [string, number]>;
  let best = 0;
  for (const [value, weight] of buckets) {
    const normalized = normalize(value);
    if (normalized && query.includes(normalized)) best = Math.max(best, weight);
    const tokens = tokenize(value);
    const overlap = [...tokens].filter((token) => queryTokens.has(token)).length;
    if (tokens.size > 0) best = Math.max(best, (overlap / tokens.size) * weight);
  }
  return Number(best.toFixed(3));
}

function termsForEntry(entry: KnowHowEntry): Record<string, string[]> {
  return {
    name: [entry.name],
    alias: entry.aliases,
    topic: entry.intent_match.topics,
    example: entry.intent_match.examples,
    source: entry.strategy.preferred_sources,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
