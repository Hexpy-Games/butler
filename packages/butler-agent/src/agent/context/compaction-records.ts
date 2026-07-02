import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { createHash } from "crypto";
import { dirname, join } from "path";
import { conversationSessionIdForDurableSession } from "../conversation/session-admission.ts";

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
  summarized_message_range?: {
    first_message_id: string | null;
    last_message_id: string | null;
    from_seq: number | null;
    to_seq: number | null;
    message_count: number;
  };
  preserved_suffix_message_ids?: string[];
  source_hash?: string | null;
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

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function compactionPath(butlerData: string, sessionId: string): string {
  return join(butlerData, "context", "compactions", `${safeId(sessionId)}.jsonl`);
}

export function compactionMetricsPath(butlerData: string): string {
  return join(butlerData, "metrics", "context-compaction.jsonl");
}

export function compactionLockPath(butlerData: string, sessionId: string): string {
  return join(butlerData, "context", "compactions", `${safeId(sessionId)}.lock`);
}

export function appendSnapshot(butlerData: string, sessionId: string, snapshot: CompactionSnapshot): void {
  const path = compactionPath(butlerData, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(snapshot)}\n`, "utf8");
}

export function safeDiagnosticCode(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_.:-]{1,80}$/.test(trimmed)) return trimmed;
  const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
  return `redacted_${hash}`;
}

export function appendCompactionMetric(input: {
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

export async function withCompactionLock<T>(
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
  const path = existingCompactionPath(input.butlerData, input.sessionId);
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
    "Use this compact session summary as continuity context. Treat provenance-backed memory and canonical conversation messages as the source of truth.",
    snapshot.summary.trim(),
    snapshot.provenance.length > 0 ? `Provenance: ${snapshot.provenance.slice(0, 8).join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

function existingCompactionPath(butlerData: string, sessionId: string): string {
  const direct = compactionPath(butlerData, sessionId);
  if (existsSync(direct)) return direct;
  return compactionPath(butlerData, conversationSessionIdForDurableSession(sessionId));
}
