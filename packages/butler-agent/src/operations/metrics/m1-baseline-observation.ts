import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptUsageReport } from "../../integrations/providers/runtime-contracts.ts";
import {
  isOperationalMetricsEnabled,
  recordOperationalMetric,
} from "./operational-metrics.ts";

export const M1_BASELINE_OBSERVATION_EVENT_NAME = "m1_baseline_arm_observed";
export const M1_BASELINE_TELEMETRY_ENV_KEY = "BUTLER_M1_BASELINE_TELEMETRY";

export type M1BaselineObservationStatus = "ok" | "error" | "skipped";
export type M1BaselineArmState =
  | "accepted"
  | "rejected"
  | "gated"
  | "measurement-ineligible";

export interface M1BaselineArmMetadataInput {
  armId?: unknown; scenario?: unknown; cacheState?: unknown; sourceRevision?: unknown;
  modelRef?: unknown; reasoning?: unknown; flagRevision?: unknown; armState?: unknown;
}

export interface M1BaselineArmMetadata {
  armId: string | null; scenario: string | null; cacheState: "cold" | "warm" | null;
  sourceRevision: string | null; modelRef: string | null; reasoning: string | null;
  flagRevision: string | null; armState: M1BaselineArmState;
}

export interface M1BaselineObservationConfig extends M1BaselineArmMetadataInput {
  enabled?: unknown;
}

export interface CreateM1BaselineObservationRecorderInput {
  butlerData: string; env?: Record<string, string | undefined>;
  config?: M1BaselineObservationConfig; metadata?: M1BaselineArmMetadataInput;
  startedAtMs?: number; now?: () => number;
}

export interface M1BaselineObservationRecorder {
  readonly enabled: boolean; readonly metadata: M1BaselineArmMetadata;
  observeModelRequest(): void;
  observeSerializedInputEstimate(tokens: number, modelRef?: string): void;
  observeProviderUsage(usage: PromptUsageReport): void;
  observeFirstUseful(): void; observeToolCall(): void; observeToolResult(ok: boolean): void;
  markMeasurementIneligible(): void;
  finalize(status: M1BaselineObservationStatus): void;
}

type NumericAccumulator = { seen: boolean; complete: boolean; total: number };

const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "off", "no"]);
const M1_BASELINE_ARM_IDS = new Set(["direct-cold", "direct-warm", "current-web-cold", "landing-cold"]);
const M1_BASELINE_SCENARIOS = new Set(["direct", "current-web", "landing-page"]);
const M1_BASELINE_REASONING = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const M1_BASELINE_ARM_STATES = new Set(["accepted", "rejected", "gated", "measurement-ineligible"]);
const REGISTERED_MODEL_PROVIDERS = new Set([
  "openai", "anthropic", "google", "xai", "qwen", "kimi", "zai", "zai-api",
  "opencode-go", "local",
]);
const CREDENTIAL_OR_PATH_MARKER = /(?:^|[-_.:])(?:sk|pk|rk|api[-_]?key|token|secret|credential|password|private|users?|home|tmp|var|path)(?:$|[-_.:])/iu;
const MAX_SAFE_COUNT = 1_000_000;
const MAX_SAFE_NUMBER = Number.MAX_SAFE_INTEGER;

export function createM1BaselineObservationRecorder(
  input: CreateM1BaselineObservationRecorderInput,
): M1BaselineObservationRecorder {
  const env = input.env ?? process.env;
  const fileConfig = readM1BaselineConfig(input.butlerData);
  const config = { ...fileConfig, ...(input.config ?? {}) };
  const metadata = resolveMetadata({
    env,
    config,
    explicit: input.metadata,
  });
  const enabled = resolveEnabled({
    env,
    config,
    butlerData: input.butlerData,
  });
  const now = input.now ?? Date.now;
  const startedAtMs = finiteNumber(input.startedAtMs) ?? safeNow(now);
  const serializedInput = emptyAccumulator();
  const localInput = emptyAccumulator();
  const providerPrompt = emptyAccumulator();
  const providerCacheRead = emptyAccumulator();
  const providerCacheWrite = emptyAccumulator();
  const providerOutput = emptyAccumulator();
  const providerTotal = emptyAccumulator();
  let modelRequests = 0;
  let firstUsefulAtMs: number | null = null;
  let toolCalls = 0;
  let toolFailures = 0;
  let finalized = false;

  const observeNumber = (target: NumericAccumulator, value: unknown): void => {
    target.seen = true;
    const safe = nonNegativeNumber(value);
    if (safe === null) {
      target.complete = false;
      return;
    }
    target.total = boundedAdd(target.total, safe);
  };

  return {
    enabled,
    metadata,

    observeModelRequest(): void {
      if (!enabled || finalized) return;
      modelRequests = Math.min(MAX_SAFE_COUNT, modelRequests + 1);
    },

    observeSerializedInputEstimate(tokens, modelRef): void {
      if (!enabled || finalized) return;
      observeNumber(serializedInput, tokens);
      const effectiveModelRef = modelRef ?? metadata.modelRef;
      if (effectiveModelRef?.startsWith("local/")) {
        observeNumber(localInput, tokens);
      }
    },

    observeProviderUsage(usage): void {
      if (!enabled || finalized) return;
      observeNumber(providerPrompt, usage.providerPromptTokens);
      observeNumber(providerCacheRead, usage.providerCacheReadTokens);
      observeNumber(providerCacheWrite, usage.providerCacheWriteTokens);
      observeNumber(providerOutput, usage.providerOutputTokens);
      observeNumber(providerTotal, usage.providerTotalTokens);
    },

    observeFirstUseful(): void {
      if (!enabled || finalized || firstUsefulAtMs !== null) return;
      firstUsefulAtMs = safeNow(now);
    },

    observeToolCall(): void {
      if (!enabled || finalized) return;
      toolCalls = Math.min(MAX_SAFE_COUNT, toolCalls + 1);
    },

    observeToolResult(ok): void {
      if (!enabled || finalized) return;
      toolFailures = Math.min(MAX_SAFE_COUNT, toolFailures + (ok ? 0 : 1));
    },

    markMeasurementIneligible(): void {
      metadata.armState = "measurement-ineligible";
    },

    finalize(status): void {
      if (finalized) return;
      finalized = true;
      if (!enabled) return;
      try {
        const at = safeNow(now);
        const elapsedMs = Math.max(0, at - startedAtMs);
        recordOperationalMetric({
          ts: at,
          category: "runtime",
          name: M1_BASELINE_OBSERVATION_EVENT_NAME,
          status,
          unit: "arm",
          dimensions: {
            ...metadata,
            serializedInputEstimateTokens: accumulatorValue(serializedInput),
            localInputEstimateTokens: accumulatorValue(localInput),
            providerPromptTokens: accumulatorValue(providerPrompt),
            providerCacheReadTokens: accumulatorValue(providerCacheRead),
            providerCacheWriteTokens: accumulatorValue(providerCacheWrite),
            providerOutputTokens: accumulatorValue(providerOutput),
            providerTotalTokens: accumulatorValue(providerTotal),
            modelRequests,
            firstUsefulLatencyMs: firstUsefulAtMs === null
              ? null
              : Math.max(0, firstUsefulAtMs - startedAtMs),
            elapsedMs,
            toolCalls,
            toolFailures,
          },
        }, { butlerData: input.butlerData, env });
      } catch {
        // Baseline telemetry is diagnostic only and cannot veto a Turn.
      }
    },
  };
}

function readM1BaselineConfig(butlerData: string): M1BaselineObservationConfig {
  try {
    const parsed = JSON.parse(readFileSync(
      join(butlerData, "butler.config.json"),
      "utf8",
    )) as unknown;
    const root = asRecord(parsed);
    const metrics = asRecord(root?.metrics);
    const candidate = asRecord(root?.m1BaselineTelemetry) ??
      asRecord(metrics?.m1BaselineTelemetry);
    return candidate ?? {};
  } catch {
    return {};
  }
}

function resolveEnabled(input: {
  env: Record<string, string | undefined>;
  config: M1BaselineObservationConfig;
  butlerData: string;
}): boolean {
  const flag = parseBoolean(input.env[M1_BASELINE_TELEMETRY_ENV_KEY]) ??
    parseBoolean(input.config.enabled) ?? true;
  return flag && isOperationalMetricsEnabled({
    butlerData: input.butlerData,
    env: input.env,
  });
}

function resolveMetadata(input: {
  env: Record<string, string | undefined>;
  config: M1BaselineObservationConfig;
  explicit?: M1BaselineArmMetadataInput;
}): M1BaselineArmMetadata {
  const value = (key: keyof M1BaselineArmMetadataInput, envKeys: string[]): unknown => {
    if (input.explicit && input.explicit[key] !== undefined) return input.explicit[key];
    for (const envKey of envKeys) {
      if (input.env[envKey] !== undefined) return input.env[envKey];
    }
    return input.config[key];
  };
  const rawArmId = value("armId", ["BUTLER_M1_BASELINE_ARM_ID", "BUTLER_M1_BASELINE_ARM"]);
  const rawScenario = value("scenario", ["BUTLER_M1_BASELINE_SCENARIO"]);
  const rawCacheState = value("cacheState", ["BUTLER_M1_BASELINE_CACHE_STATE"]);
  const rawSourceRevision = value("sourceRevision", ["BUTLER_M1_BASELINE_SOURCE_REVISION"]);
  const rawModelRef = value("modelRef", ["BUTLER_M1_BASELINE_MODEL_REF"]);
  const rawReasoning = value("reasoning", ["BUTLER_M1_BASELINE_REASONING"]);
  const rawFlagRevision = value("flagRevision", ["BUTLER_M1_BASELINE_FLAG_REVISION"]);
  const rawArmState = value("armState", ["BUTLER_M1_BASELINE_ARM_STATE"]);
  const armId = safeArmId(rawArmId);
  const scenario = safeScenario(rawScenario);
  const cacheState = safeCacheState(rawCacheState);
  const sourceRevision = safeSourceRevision(rawSourceRevision);
  const modelRef = safeModelRef(rawModelRef);
  const reasoning = safeReasoning(rawReasoning);
  const flagRevision = safeFlagRevision(rawFlagRevision);
  const armState = safeArmState(rawArmState);
  const invalidProvidedMetadata = [
    [rawArmId, armId], [rawScenario, scenario], [rawCacheState, cacheState],
    [rawSourceRevision, sourceRevision], [rawModelRef, modelRef],
    [rawReasoning, reasoning], [rawFlagRevision, flagRevision], [rawArmState, armState],
  ].some(([raw, safe]) => raw !== undefined && raw !== null && safe === null);
  return {
    armId,
    scenario,
    cacheState,
    sourceRevision,
    modelRef,
    reasoning,
    flagRevision,
    armState: invalidProvidedMetadata ? "measurement-ineligible" : armState ?? "gated",
  };
}

function safeArmId(value: unknown): string | null { return safeEnum(value, M1_BASELINE_ARM_IDS); }
function safeScenario(value: unknown): string | null { return safeEnum(value, M1_BASELINE_SCENARIOS); }
function safeReasoning(value: unknown): string | null { return safeEnum(value, M1_BASELINE_REASONING); }
function safeEnum(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === "string" && allowed.has(value.trim()) ? value.trim() : null;
}
function safeSourceRevision(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value.trim()) ? value.trim().toLowerCase() : null;
}
function safeModelRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9-]{1,31}\/[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(trimmed)) return null;
  const separator = trimmed.indexOf("/");
  const provider = trimmed.slice(0, separator);
  const model = trimmed.slice(separator + 1);
  if (!REGISTERED_MODEL_PROVIDERS.has(provider) || CREDENTIAL_OR_PATH_MARKER.test(model)) return null;
  return trimmed;
}
function safeFlagRevision(value: unknown): string | null {
  return typeof value === "string" && /^m1-t1-v[0-9]{1,4}$/u.test(value.trim()) ? value.trim() : null;
}

function safeCacheState(value: unknown): "cold" | "warm" | null {
  return value === "cold" || value === "warm" ? value : null;
}
function safeArmState(value: unknown): M1BaselineArmState | null {
  return typeof value === "string" && M1_BASELINE_ARM_STATES.has(value)
    ? value as M1BaselineArmState
    : null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return TRUE_VALUES.has(normalized) ? true : FALSE_VALUES.has(normalized) ? false : null;
}

function emptyAccumulator(): NumericAccumulator { return { seen: false, complete: true, total: 0 }; }

function accumulatorValue(value: NumericAccumulator): number | null { return value.seen && value.complete ? value.total : null; }

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_SAFE_NUMBER, Math.max(0, Math.floor(value))) : null;
}

function boundedAdd(left: number, right: number): number { return Math.min(MAX_SAFE_NUMBER, left + right); }

function finiteNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }

function safeNow(now: () => number): number {
  try { return finiteNumber(now()) ?? Date.now(); } catch { return Date.now(); }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
