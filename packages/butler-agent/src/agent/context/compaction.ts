import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { createHash } from "crypto";
import { dirname, join } from "path";
import { readTranscript, type TranscriptEvent } from "../../test-support/harness/transcripts.ts";
import {
  estimateContextTokens,
  evaluateWorkingContextBudget,
  evaluateContextBudget,
  trimTextToTokenBudget,
  type ContextBudgetOverrides,
} from "./budget.ts";

export interface CompactionSnapshot {
  schema: "butler.context.compaction.v1";
  snapshot_id: string;
  session_id: string;
  trigger: "manual" | "auto" | "repair";
  status: "ok" | "failed";
  created_at: string;
  model_ref: string | null;
  model_context_window_tokens: number;
  pre_estimated_tokens: number;
  post_estimated_tokens: number;
  summarized_event_range: {
    first_event_id: string | null;
    last_event_id: string | null;
    event_count: number;
  };
  preserved_suffix_event_ids: string[];
  summary: string;
  provenance: string[];
  diagnostics: string[];
  region_tokens?: {
    working_context_tokens: number;
    available_working_context_tokens: number;
    used_working_ratio: number;
    static_context_tokens: number;
    live_configuration_tokens: number;
    runtime_state_tokens: number;
    compaction_prompt_reserve_tokens?: number;
  };
  known_gaps?: string[];
}

export interface CompactionMetricEvent {
  schema: "butler.context-compaction-metric.v1";
  ts: number;
  sessionId: string;
  snapshotId: string;
  trigger: CompactionSnapshot["trigger"];
  status: CompactionSnapshot["status"];
  durationMs: number;
  modelRef: string | null;
  preEstimatedTokens: number;
  postEstimatedTokens: number;
  reductionRatio: number;
  diagnostics: string[];
  rawTextStored: false;
}

export interface CompactTranscriptOptions {
  butlerData: string;
  sessionId: string;
  modelRef?: string | null;
  trigger: CompactionSnapshot["trigger"];
  preserveLastEvents?: number;
  chunkTokenBudget?: number;
  summaryTokenBudget?: number;
  budgetOverrides?: ContextBudgetOverrides;
  now?: () => string;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function compactionPath(butlerData: string, sessionId: string): string {
  return join(butlerData, "context", "compactions", `${safeId(sessionId)}.jsonl`);
}

export function compactionMetricsPath(butlerData: string): string {
  return join(butlerData, "metrics", "context-compaction.jsonl");
}

function compactionLockPath(butlerData: string, sessionId: string): string {
  return join(butlerData, "context", "compactions", `${safeId(sessionId)}.lock`);
}

function eventText(event: TranscriptEvent): string {
  const payload = event.payload as Record<string, any>;
  const text = payload.message?.text ?? payload.text ?? payload.result?.summary ?? payload.summary;
  const cleanText = typeof text === "string" ? text.trim() : "";
  const role = event.kind === "inbound"
    ? "user"
    : event.kind === "outbound"
      ? "butler"
      : event.kind;
  return cleanText ? `${role}: ${cleanText}` : `${role}: ${JSON.stringify(payload).slice(0, 500)}`;
}

function eventsAfterSummarizedRange(events: TranscriptEvent[], snapshot: CompactionSnapshot): TranscriptEvent[] | null {
  const lastSummarizedEventId = snapshot.summarized_event_range.last_event_id;
  if (!lastSummarizedEventId) return events;
  const lastSummarizedIndex = events.findIndex((event) => event.eventId === lastSummarizedEventId);
  if (lastSummarizedIndex < 0) return null;
  return events.slice(lastSummarizedIndex + 1);
}

function effectiveWorkingTextAfterCompaction(events: TranscriptEvent[], snapshot: CompactionSnapshot | null): string {
  if (!snapshot || snapshot.status !== "ok") return events.map(eventText).join("\n");
  const unsummarizedEvents = eventsAfterSummarizedRange(events, snapshot);
  if (!unsummarizedEvents) return events.map(eventText).join("\n");
  return [
    snapshot.summary.trim() ? `compaction_summary: ${snapshot.summary.trim()}` : "",
    ...unsummarizedEvents.map(eventText),
  ].filter(Boolean).join("\n");
}

function summarizeEvents(events: TranscriptEvent[], maxTokens: number): string {
  if (events.length === 0) return "";
  const lines = events.map(eventText).filter(Boolean);
  const candidates = [
    ...lines.slice(0, 4),
    ...lines.slice(-4),
  ];
  const unique = Array.from(new Set(candidates));
  const summary = [
    `Events summarized: ${events.length}.`,
    ...unique.map((line) => `- ${line}`),
  ].join("\n");
  return trimTextToTokenBudget(summary, maxTokens, { from: "start" });
}

function chunkEvents(events: TranscriptEvent[], chunkTokenBudget: number): TranscriptEvent[][] {
  const chunks: TranscriptEvent[][] = [];
  let current: TranscriptEvent[] = [];
  let used = 0;
  for (const event of events) {
    const tokens = estimateContextTokens(eventText(event));
    if (current.length > 0 && used + tokens > chunkTokenBudget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(event);
    used += tokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function appendSnapshot(butlerData: string, sessionId: string, snapshot: CompactionSnapshot): void {
  const path = compactionPath(butlerData, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(snapshot)}\n`, "utf8");
}

function safeDiagnosticCode(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_.:-]{1,80}$/.test(trimmed)) return trimmed;
  const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
  return `redacted_${hash}`;
}

function appendCompactionMetric(input: {
  butlerData: string;
  snapshot: CompactionSnapshot;
  durationMs: number;
  ts?: number;
}): void {
  const path = compactionMetricsPath(input.butlerData);
  const reductionRatio = input.snapshot.pre_estimated_tokens > 0
    ? 1 - (input.snapshot.post_estimated_tokens / input.snapshot.pre_estimated_tokens)
    : 0;
  const metric: CompactionMetricEvent = {
    schema: "butler.context-compaction-metric.v1",
    ts: input.ts ?? Date.now(),
    sessionId: input.snapshot.session_id,
    snapshotId: input.snapshot.snapshot_id,
    trigger: input.snapshot.trigger,
    status: input.snapshot.status,
    durationMs: Math.max(0, input.durationMs),
    modelRef: input.snapshot.model_ref,
    preEstimatedTokens: input.snapshot.pre_estimated_tokens,
    postEstimatedTokens: input.snapshot.post_estimated_tokens,
    reductionRatio: Math.max(0, reductionRatio),
    diagnostics: input.snapshot.diagnostics.map(safeDiagnosticCode),
    rawTextStored: false,
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(metric)}\n`, "utf8");
}

export function readCompactionMetrics(input: {
  butlerData: string;
  sessionId?: string;
}): CompactionMetricEvent[] {
  const path = compactionMetricsPath(input.butlerData);
  if (!existsSync(path)) return [];
  const events: CompactionMetricEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as CompactionMetricEvent;
      if (
        parsed?.schema === "butler.context-compaction-metric.v1" &&
        (!input.sessionId || parsed.sessionId === input.sessionId)
      ) {
        events.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return events.sort((a, b) => a.ts - b.ts);
}

async function withCompactionLock<T>(
  butlerData: string,
  sessionId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const lockPath = compactionLockPath(butlerData, sessionId);
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`Context compaction lock timed out for ${sessionId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

export function readCompactionSnapshots(input: {
  butlerData: string;
  sessionId: string;
}): CompactionSnapshot[] {
  const path = compactionPath(input.butlerData, input.sessionId);
  if (!existsSync(path)) return [];
  const snapshots: CompactionSnapshot[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as CompactionSnapshot;
      if (parsed?.schema === "butler.context.compaction.v1") snapshots.push(parsed);
    } catch {
      continue;
    }
  }
  return snapshots;
}

export function readLatestCompactionSnapshot(input: {
  butlerData: string;
  sessionId: string;
}): CompactionSnapshot | null {
  const snapshots = readCompactionSnapshots(input);
  return [...snapshots].reverse().find((snapshot) => snapshot.status === "ok") ?? null;
}

export function renderCompactionContext(snapshot: CompactionSnapshot | null): string {
  if (!snapshot || !snapshot.summary.trim()) return "";
  return [
    "## Compaction Summary",
    "Use this compact session summary as continuity context. Treat provenance-backed memory and transcripts as the source of truth.",
    snapshot.summary.trim(),
    snapshot.provenance.length > 0 ? `Provenance: ${snapshot.provenance.slice(0, 8).join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

export async function compactTranscript(options: CompactTranscriptOptions): Promise<CompactionSnapshot> {
  const startedMs = Date.now();
  return await withCompactionLock(options.butlerData, options.sessionId, async () => {
    const events = readTranscript(options.sessionId)
      .filter((event) => event.kind === "inbound" || event.kind === "outbound" || event.kind === "tool_result" || event.kind === "worker_status");
    const preserveLastEvents = Math.max(2, options.preserveLastEvents ?? 8);
    const preserved = events.slice(-preserveLastEvents);
    const toSummarize = events.slice(0, Math.max(0, events.length - preserved.length));
    const preText = events.map(eventText).join("\n");
    const preTokens = estimateContextTokens(preText);
    const budget = evaluateContextBudget({
      modelRef: options.modelRef,
      inputTokens: preTokens,
      overrides: options.budgetOverrides,
    });
    const workingBudget = evaluateWorkingContextBudget({
      modelRef: options.modelRef,
      workingContextTokens: preTokens,
      overrides: options.budgetOverrides,
    });
    const now = options.now?.() ?? new Date().toISOString();
    const chunkTokenBudget = Math.max(500, options.chunkTokenBudget ?? Math.floor(budget.contextWindowTokens * 0.20));
    const summaryTokenBudget = options.summaryTokenBudget
      ? Math.max(200, options.summaryTokenBudget)
      : Math.max(200, Math.min(1_200, Math.floor(budget.contextWindowTokens * 0.15)));
    const diagnostics: string[] = [];

    let summary = "";
    if (toSummarize.length === 0) {
      diagnostics.push("no_events_to_summarize");
    } else if (estimateContextTokens(toSummarize.map(eventText).join("\n")) <= chunkTokenBudget) {
      summary = summarizeEvents(toSummarize, summaryTokenBudget);
    } else {
      diagnostics.push("hierarchical_chunk_compaction");
      const chunkSummaries = chunkEvents(toSummarize, chunkTokenBudget)
        .map((chunk, index) => `Chunk ${index + 1}: ${summarizeEvents(chunk, Math.max(250, Math.floor(summaryTokenBudget / 2)))}`);
      summary = trimTextToTokenBudget(chunkSummaries.join("\n\n"), summaryTokenBudget, { from: "start" });
    }

    const status: CompactionSnapshot["status"] = summary.trim() || toSummarize.length === 0 ? "ok" : "failed";
    if (status === "failed") diagnostics.push("summary_empty");
    const preservedTokens = estimateContextTokens(preserved.map(eventText).join("\n"));
    const maxSummaryTokens = Math.max(100, preTokens - preservedTokens - 1);
    summary = trimTextToTokenBudget(summary, Math.min(summaryTokenBudget, maxSummaryTokens), { from: "start" });
    const postTokens = estimateContextTokens(summary) + preservedTokens;
    const snapshot: CompactionSnapshot = {
      schema: "butler.context.compaction.v1",
      snapshot_id: `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      session_id: options.sessionId,
      trigger: options.trigger,
      status,
      created_at: now,
      model_ref: options.modelRef ?? null,
      model_context_window_tokens: budget.contextWindowTokens,
      pre_estimated_tokens: preTokens,
      post_estimated_tokens: postTokens,
      summarized_event_range: {
        first_event_id: toSummarize[0]?.eventId ?? null,
        last_event_id: toSummarize.at(-1)?.eventId ?? null,
        event_count: toSummarize.length,
      },
      preserved_suffix_event_ids: preserved.map((event) => event.eventId),
      summary: summary.trim(),
      provenance: toSummarize.slice(0, 20).map((event) => event.eventId),
      diagnostics,
      region_tokens: {
        working_context_tokens: preTokens,
        available_working_context_tokens: workingBudget.availableWorkingContextTokens,
        used_working_ratio: workingBudget.usedWorkingRatio,
        static_context_tokens: workingBudget.staticContextTokens,
        live_configuration_tokens: workingBudget.liveConfigurationTokens,
        runtime_state_tokens: workingBudget.runtimeStateTokens,
        compaction_prompt_reserve_tokens: workingBudget.compactionPromptReserveTokens,
      },
      known_gaps: [],
    };
    appendSnapshot(options.butlerData, options.sessionId, snapshot);
    appendCompactionMetric({
      butlerData: options.butlerData,
      snapshot,
      durationMs: Date.now() - startedMs,
    });
    return snapshot;
  });
}

export async function maybeAutoCompactSession(input: {
  butlerData: string;
  sessionId: string;
  modelRef?: string | null;
  budgetOverrides?: ContextBudgetOverrides;
}): Promise<CompactionSnapshot | null> {
  const events = readTranscript(input.sessionId);
  const rawTokens = estimateContextTokens(events.map(eventText).join("\n"));
  const latest = readLatestCompactionSnapshot({
    butlerData: input.butlerData,
    sessionId: input.sessionId,
  });
  const effectiveWorkingTokens = estimateContextTokens(effectiveWorkingTextAfterCompaction(events, latest));
  const budget = evaluateWorkingContextBudget({
    modelRef: input.modelRef,
    workingContextTokens: effectiveWorkingTokens,
    overrides: input.budgetOverrides,
  });
  if (!budget.shouldAutoCompact) return null;
  if (latest && latest.pre_estimated_tokens >= rawTokens) return null;
  return await compactTranscript({
    butlerData: input.butlerData,
    sessionId: input.sessionId,
    modelRef: input.modelRef,
    trigger: "auto",
    budgetOverrides: input.budgetOverrides,
  });
}

export function writeFailedCompactionDiagnostic(input: {
  butlerData: string;
  sessionId: string;
  modelRef?: string | null;
  reason: string;
}): CompactionSnapshot {
  const now = new Date().toISOString();
  const snapshot: CompactionSnapshot = {
    schema: "butler.context.compaction.v1",
    snapshot_id: `cmp_failed_${Date.now().toString(36)}`,
    session_id: input.sessionId,
    trigger: "auto",
    status: "failed",
    created_at: now,
    model_ref: input.modelRef ?? null,
    model_context_window_tokens: 0,
    pre_estimated_tokens: 0,
    post_estimated_tokens: 0,
    summarized_event_range: {
      first_event_id: null,
      last_event_id: null,
      event_count: 0,
    },
    preserved_suffix_event_ids: [],
    summary: "",
    provenance: [],
    diagnostics: [safeDiagnosticCode(input.reason)],
  };
  appendSnapshot(input.butlerData, input.sessionId, snapshot);
  appendCompactionMetric({
    butlerData: input.butlerData,
    snapshot,
    durationMs: 0,
  });
  return snapshot;
}
