import {
  readOperationalMetricEvents,
  recordOperationalMetric,
  type OperationalMetricEvent,
  type OperationalMetricStatus,
} from "./operational-metrics.ts";

export const FIRST_VISIBLE_LATENCY_METRIC_NAME = "first_visible_latency";
export const TURN_PREPARATION_STEP_METRIC_NAME = "turn_preparation_step";

export type FirstVisibleSignal =
  | "acknowledged"
  | "first_progress"
  | "runtime_preparation"
  | "assistant_before_tools"
  | "tool_call"
  | "todo"
  | "final";

export type TurnPreparationStep =
  | "context_compaction"
  | "automatic_recall"
  | "compaction_context"
  | "feedback_buffer"
  | "working_memory"
  | "runtime_policy"
  | "prompt_normalization"
  | "attachment_context"
  | "runtime_preparation_progress";

export interface FirstVisibleLatencyInput {
  butlerData: string;
  durationMs: number;
  signal: FirstVisibleSignal;
  status?: OperationalMetricStatus;
  transport?: string;
  role?: string;
  runtime?: string;
  model?: string;
  source?: string;
  now?: number;
}

export interface TurnPreparationStepInput {
  butlerData: string;
  step: TurnPreparationStep;
  durationMs: number;
  status?: OperationalMetricStatus;
  role?: string;
  runtime?: string;
  model?: string;
  skippedReason?: string;
  now?: number;
}

export interface FirstVisibleLatencySummary {
  events: number;
  latest: OperationalMetricEvent | null;
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  bySignal: Partial<Record<FirstVisibleSignal, number>>;
  privacy: {
    rawTextStored: false;
  };
}

const MAX_SAFE_DIMENSION_IDENTIFIER_CHARS = 80;

function finiteDurationMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function safeDimensionIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/(prompt|message|transcript|query|url|uri|args?|arguments?|result|content|raw|secret|password|credential|apikey|api_key|key|token)/i.test(trimmed)) {
    return undefined;
  }
  if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(trimmed)) return undefined;
  if (trimmed.length > MAX_SAFE_DIMENSION_IDENTIFIER_CHARS) return undefined;
  return trimmed;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function signalFromMetric(event: OperationalMetricEvent): FirstVisibleSignal | null {
  const signal = event.dimensions?.signal;
  return typeof signal === "string" ? signal as FirstVisibleSignal : null;
}

export function recordFirstVisibleLatencyMetric(input: FirstVisibleLatencyInput): void {
  recordOperationalMetric({
    ts: input.now,
    category: "runtime",
    name: FIRST_VISIBLE_LATENCY_METRIC_NAME,
    status: input.status ?? "ok",
    durationMs: finiteDurationMs(input.durationMs),
    unit: "ms",
    dimensions: {
      signal: input.signal,
      transport: input.transport,
      role: input.role,
      runtime: input.runtime,
      model: input.model,
      source: safeDimensionIdentifier(input.source),
    },
  }, { butlerData: input.butlerData });
}

export function recordTurnPreparationStepMetric(input: TurnPreparationStepInput): void {
  recordOperationalMetric({
    ts: input.now,
    category: "runtime",
    name: TURN_PREPARATION_STEP_METRIC_NAME,
    status: input.status ?? "ok",
    durationMs: finiteDurationMs(input.durationMs),
    unit: "ms",
    dimensions: {
      step: input.step,
      role: input.role,
      runtime: input.runtime,
      model: input.model,
      skippedReason: safeDimensionIdentifier(input.skippedReason),
    },
  }, { butlerData: input.butlerData });
}

export function readFirstVisibleLatencySummary(input: {
  butlerData: string;
  sinceTs?: number;
}): FirstVisibleLatencySummary {
  const events = readOperationalMetricEvents({
    butlerData: input.butlerData,
    sinceTs: input.sinceTs,
  }).filter((event) => event.category === "runtime" && event.name === FIRST_VISIBLE_LATENCY_METRIC_NAME);
  const durations = events
    .map((event) => event.durationMs)
    .filter((duration): duration is number => typeof duration === "number");
  const bySignal: Partial<Record<FirstVisibleSignal, number>> = {};
  for (const event of events) {
    const signal = signalFromMetric(event);
    if (signal) bySignal[signal] = (bySignal[signal] ?? 0) + 1;
  }
  const sum = durations.reduce((total, duration) => total + duration, 0);
  return {
    events: events.length,
    latest: events.at(-1) ?? null,
    averageMs: durations.length ? Number((sum / durations.length).toFixed(2)) : null,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    bySignal,
    privacy: {
      rawTextStored: false,
    },
  };
}
