import {
  recordOperationalMetric,
  type OperationalMetricEvent,
  type OperationalMetricStatus,
} from "./operational-metrics.ts";
import { FIRST_VISIBLE_LATENCY_METRIC_NAME } from "./first-visible-latency.ts";
import type { PromptCacheMetricEvent } from "../../integrations/providers/prompt-cache-metrics.ts";
import type {
  PromptUsageBudgetState,
  ProviderStreamTextTarget,
} from "../../integrations/providers/provider.ts";

export const FIRST_MODEL_DELTA_LATENCY_METRIC_NAME = "first_model_delta_latency_ms";
export const FIRST_TOOL_EVENT_LATENCY_METRIC_NAME = "first_tool_event_latency_ms";
export const MODEL_REQUEST_BY_PHASE_METRIC_NAME = "model_request_count_by_phase";
export const MODEL_RESPONSE_USAGE_BY_PHASE_METRIC_NAME = "model_response_usage_by_phase";
export const TOOL_CALL_BY_PHASE_METRIC_NAME = "tool_call_count_by_phase";
export const PHASE_BUDGET_EXHAUSTED_METRIC_NAME = "phase_budget_exhausted";

export type FirstToolEventKind = "work.block.started" | "tool.started";

export interface TurnLatencyMetricRecorder {
  recordFirstModelDelta(input: {
    phase: string;
    target?: ProviderStreamTextTarget;
  }): void;
  recordFirstToolEvent(input: {
    eventKind: FirstToolEventKind;
  }): void;
  recordModelRequest(input: {
    phase: string;
    roundIndex: number;
    budgetState: PromptUsageBudgetState;
  }): void;
  recordModelResponseUsage(input: {
    phase: string;
    roundIndex: number;
    promptTokens: number | null;
    cachedTokens: number;
    outputTokens: number;
    totalTokens: number | null;
    budgetState: PromptUsageBudgetState;
  }): void;
}

export interface TurnLatencyMetricRecorderInput {
  butlerData: string;
  startedAt: number;
  role?: string;
  runtime?: string;
  model?: string;
  now?: () => number;
}

export interface TurnLatencyBaselineSummary {
  firstVisibleProgressLatencyMs: number | null;
  firstModelDeltaLatencyMs: number | null;
  firstToolEventLatencyMs: number | null;
  modelRequestCountByPhase: Record<string, number>;
  toolCallCountByPhase: Record<string, number>;
  promptTokensByPhase: Record<string, number>;
  maxModelRequests: number | null;
  phaseBudgetExhausted: boolean;
  privacy: {
    rawTextStored: false;
  };
}

const MAX_SAFE_DIMENSION_IDENTIFIER_CHARS = 80;

export function createTurnLatencyMetricRecorder(
  input: TurnLatencyMetricRecorderInput,
): TurnLatencyMetricRecorder {
  const now = input.now ?? Date.now;
  let firstModelDeltaRecorded = false;
  let firstToolEventRecorded = false;

  const commonDimensions = () => ({
    role: safeDimensionIdentifier(input.role),
    runtime: safeDimensionIdentifier(input.runtime),
    model: safeDimensionIdentifier(input.model),
  });

  return {
    recordFirstModelDelta(delta): void {
      if (firstModelDeltaRecorded) return;
      firstModelDeltaRecorded = true;
      const at = now();
      recordOperationalMetric({
        ts: at,
        category: "runtime",
        name: FIRST_MODEL_DELTA_LATENCY_METRIC_NAME,
        status: "ok",
        durationMs: at - input.startedAt,
        unit: "ms",
        dimensions: {
          ...commonDimensions(),
          phase: safeDimensionIdentifier(delta.phase),
          target: safeDimensionIdentifier(delta.target),
        },
      }, { butlerData: input.butlerData });
    },

    recordFirstToolEvent(event): void {
      if (firstToolEventRecorded) return;
      firstToolEventRecorded = true;
      const at = now();
      recordOperationalMetric({
        ts: at,
        category: "runtime",
        name: FIRST_TOOL_EVENT_LATENCY_METRIC_NAME,
        status: "ok",
        durationMs: at - input.startedAt,
        unit: "ms",
        dimensions: {
          ...commonDimensions(),
          eventKind: event.eventKind,
        },
      }, { butlerData: input.butlerData });
    },

    recordModelRequest(request): void {
      recordOperationalMetric({
        ts: now(),
        category: "runtime",
        name: MODEL_REQUEST_BY_PHASE_METRIC_NAME,
        status: budgetMetricStatus(request.budgetState),
        value: 1,
        unit: "request",
        dimensions: {
          ...commonDimensions(),
          phase: safeDimensionIdentifier(request.phase),
          roundIndex: nonNegativeInteger(request.roundIndex),
          requestCount: nonNegativeInteger(request.budgetState.requestCount),
          maxRequests: nonNegativeInteger(request.budgetState.maxRequests),
          budgetStatus: request.budgetState.status,
        },
      }, { butlerData: input.butlerData });
    },

    recordModelResponseUsage(usage): void {
      const promptTokens = nullableNonNegativeInteger(usage.promptTokens);
      const totalTokens = nullableNonNegativeInteger(usage.totalTokens);
      recordOperationalMetric({
        ts: now(),
        category: "runtime",
        name: MODEL_RESPONSE_USAGE_BY_PHASE_METRIC_NAME,
        status: budgetMetricStatus(usage.budgetState),
        value: totalTokens ?? promptTokens ?? 0,
        unit: "tokens",
        dimensions: {
          ...commonDimensions(),
          phase: safeDimensionIdentifier(usage.phase),
          roundIndex: nonNegativeInteger(usage.roundIndex),
          promptTokens,
          cachedTokens: nonNegativeInteger(usage.cachedTokens),
          outputTokens: nonNegativeInteger(usage.outputTokens),
          totalTokens,
          requestCount: nonNegativeInteger(usage.budgetState.requestCount),
          maxRequests: nonNegativeInteger(usage.budgetState.maxRequests),
          budgetStatus: usage.budgetState.status,
        },
      }, { butlerData: input.butlerData });
    },
  };
}

export function summarizeTurnLatencyBaseline(input: {
  operationalEvents: OperationalMetricEvent[];
  promptCacheEvents?: PromptCacheMetricEvent[];
}): TurnLatencyBaselineSummary {
  const operationalEvents = input.operationalEvents
    .filter((event) => event.category === "runtime");
  const modelRequestCountByPhase: Record<string, number> = {};
  const toolCallCountByPhase: Record<string, number> = {};
  let firstVisibleProgressLatencyMs: number | null = null;
  let firstModelDeltaLatencyMs: number | null = null;
  let firstToolEventLatencyMs: number | null = null;
  let maxModelRequests: number | null = null;
  let phaseBudgetExhausted = false;

  for (const event of operationalEvents) {
    if (event.name === FIRST_VISIBLE_LATENCY_METRIC_NAME || event.name === "first_visible_progress_latency_ms") {
      firstVisibleProgressLatencyMs ??= event.durationMs ?? null;
    } else if (event.name === FIRST_MODEL_DELTA_LATENCY_METRIC_NAME) {
      firstModelDeltaLatencyMs ??= event.durationMs ?? null;
    } else if (event.name === FIRST_TOOL_EVENT_LATENCY_METRIC_NAME) {
      firstToolEventLatencyMs ??= event.durationMs ?? null;
    } else if (event.name === MODEL_REQUEST_BY_PHASE_METRIC_NAME) {
      const phase = stringDimension(event, "phase") ?? "unknown";
      modelRequestCountByPhase[phase] = (modelRequestCountByPhase[phase] ?? 0) + 1;
      const eventMaxRequests = numberDimension(event, "maxRequests");
      if (eventMaxRequests !== null) {
        maxModelRequests = maxModelRequests === null
          ? eventMaxRequests
          : Math.max(maxModelRequests, eventMaxRequests);
      }
      phaseBudgetExhausted = phaseBudgetExhausted ||
        event.status === "error" ||
        stringDimension(event, "budgetStatus") === "exhausted";
    } else if (event.name === TOOL_CALL_BY_PHASE_METRIC_NAME) {
      const phase = stringDimension(event, "phase") ?? "unknown";
      toolCallCountByPhase[phase] = (toolCallCountByPhase[phase] ?? 0) + 1;
    } else if (event.name === PHASE_BUDGET_EXHAUSTED_METRIC_NAME) {
      phaseBudgetExhausted = true;
    }
  }

  const promptTokensByPhase = promptTokensByPhaseFrom(input.promptCacheEvents ?? []);
  if (maxModelRequests !== null) {
    phaseBudgetExhausted = phaseBudgetExhausted ||
      Object.values(modelRequestCountByPhase).some((count) => count >= maxModelRequests);
  }

  return {
    firstVisibleProgressLatencyMs,
    firstModelDeltaLatencyMs,
    firstToolEventLatencyMs,
    modelRequestCountByPhase,
    toolCallCountByPhase,
    promptTokensByPhase,
    maxModelRequests,
    phaseBudgetExhausted,
    privacy: {
      rawTextStored: false,
    },
  };
}

function promptTokensByPhaseFrom(events: PromptCacheMetricEvent[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const event of events) {
    const phase = event.phase?.trim() || "unknown";
    result[phase] = (result[phase] ?? 0) + nonNegativeInteger(event.promptTokens);
  }
  return result;
}

function stringDimension(event: OperationalMetricEvent, key: string): string | null {
  const value = event.dimensions?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function numberDimension(event: OperationalMetricEvent, key: string): number | null {
  const value = event.dimensions?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function budgetMetricStatus(state: PromptUsageBudgetState): OperationalMetricStatus {
  return state.status === "exhausted" ? "error" : "ok";
}

function nonNegativeInteger(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value ?? 0)) : 0;
}

function nullableNonNegativeInteger(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null;
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
