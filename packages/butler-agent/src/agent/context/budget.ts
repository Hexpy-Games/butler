import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { estimateTokensForModel, resolveModelMetadata, type TokenEstimatorKind } from "../../integrations/providers/model-catalog.ts";
import { parseModelRef } from "../../integrations/providers/model-ref.ts";

export type ContextThresholdState = "normal" | "warning" | "auto_compact" | "hard_pressure";
export type ContextPressureLevel = "low" | "medium" | "high";

export interface ContextBudgetConfig {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  reservedToolTokens: number;
  warningThresholdRatio: number;
  autoCompactThresholdRatio: number;
  hardThresholdRatio: number;
}

export interface ContextBudgetEvaluation extends ContextBudgetConfig {
  modelRef: string;
  providerId: string;
  modelId: string;
  inputTokens: number;
  tokenEstimator: TokenEstimatorKind;
  usedRatio: number;
  freeTokens: number;
  freeTokensAfterReserve: number;
  thresholdState: ContextThresholdState;
  pressureLevel: ContextPressureLevel;
  shouldWarn: boolean;
  shouldAutoCompact: boolean;
  shouldHardPressure: boolean;
}

export interface WorkingContextBudgetEvaluation extends ContextBudgetConfig {
  modelRef: string;
  providerId: string;
  modelId: string;
  tokenEstimator: TokenEstimatorKind;
  workingContextTokens: number;
  staticContextTokens: number;
  liveConfigurationTokens: number;
  runtimeStateTokens: number;
  compactionPromptReserveTokens: number;
  availableWorkingContextTokens: number;
  usedWorkingRatio: number;
  shouldAutoCompact: boolean;
  shouldHardPressure: boolean;
  usableUserMessageTokens: number;
}

export interface ContextBudgetOverrides {
  contextWindowTokens?: number;
  reservedOutputTokens?: number;
  reservedToolTokens?: number;
  modelWindows?: Record<string, number>;
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const DEFAULT_RESERVED_OUTPUT_RATIO = 0.125;
const DEFAULT_RESERVED_TOOL_RATIO = 0.10;
const DEFAULT_COMPACTION_PROMPT_RESERVE_RATIO = 0.05;
const MIN_DYNAMIC_RESERVED_OUTPUT_TOKENS = 1_024;
const MIN_DYNAMIC_RESERVED_TOOL_TOKENS = 1_024;
const MIN_DYNAMIC_COMPACTION_PROMPT_RESERVE_TOKENS = 768;
const MAX_DYNAMIC_RESERVED_OUTPUT_TOKENS = 8_000;
const MAX_DYNAMIC_RESERVED_TOOL_TOKENS = 8_000;
const MAX_DYNAMIC_COMPACTION_PROMPT_RESERVE_TOKENS = 4_000;
const WARNING_THRESHOLD_RATIO = 0.70;
const AUTO_COMPACT_THRESHOLD_RATIO = 0.80;
const HARD_THRESHOLD_RATIO = 0.90;
export const WORKING_CONTEXT_AUTO_COMPACT_RATIO = 0.94;
export const WORKING_CONTEXT_HARD_PRESSURE_RATIO = 0.985;

function getButlerData(): string {
  return process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value) > 0 ? Math.trunc(value) : null;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && Math.trunc(parsed) > 0 ? Math.trunc(parsed) : null;
  }
  return null;
}

function readConfig(): Record<string, any> {
  const path = join(getButlerData(), "butler.config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    return {};
  }
}

function canonicalModelRef(modelRef: string | null | undefined): string {
  const raw = modelRef?.trim() || "openai/gpt-5.5-codex";
  return parseModelRef(raw).canonicalRef;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function adaptiveReserveTokens(input: {
  contextWindowTokens: number;
  ratio: number;
  minTokens: number;
  maxTokens: number;
}): number {
  const contextWindowTokens = Math.max(1, Math.trunc(input.contextWindowTokens));
  const windowCap = Math.max(128, Math.floor(contextWindowTokens * 0.25));
  const maxTokens = Math.min(input.maxTokens, windowCap);
  const minTokens = Math.min(input.minTokens, maxTokens);
  return clampInteger(Math.round(contextWindowTokens * input.ratio), minTokens, maxTokens);
}

export function defaultReservedOutputTokens(contextWindowTokens: number): number {
  return adaptiveReserveTokens({
    contextWindowTokens,
    ratio: DEFAULT_RESERVED_OUTPUT_RATIO,
    minTokens: MIN_DYNAMIC_RESERVED_OUTPUT_TOKENS,
    maxTokens: MAX_DYNAMIC_RESERVED_OUTPUT_TOKENS,
  });
}

export function defaultReservedToolTokens(contextWindowTokens: number): number {
  return adaptiveReserveTokens({
    contextWindowTokens,
    ratio: DEFAULT_RESERVED_TOOL_RATIO,
    minTokens: MIN_DYNAMIC_RESERVED_TOOL_TOKENS,
    maxTokens: MAX_DYNAMIC_RESERVED_TOOL_TOKENS,
  });
}

export function defaultCompactionPromptReserveTokens(contextWindowTokens: number): number {
  return adaptiveReserveTokens({
    contextWindowTokens,
    ratio: DEFAULT_COMPACTION_PROMPT_RESERVE_RATIO,
    minTokens: MIN_DYNAMIC_COMPACTION_PROMPT_RESERVE_TOKENS,
    maxTokens: MAX_DYNAMIC_COMPACTION_PROMPT_RESERVE_TOKENS,
  });
}

export function estimateContextTokens(textOrChars: string | number | null | undefined): number {
  return estimateTokensForModel(textOrChars).tokens;
}

export function estimateContextTokensForModel(
  textOrChars: string | number | null | undefined,
  modelRef?: string | null,
): { tokens: number; source: TokenEstimatorKind } {
  return estimateTokensForModel(textOrChars, modelRef);
}

export function resolveContextBudgetConfig(
  modelRef: string | null | undefined,
  overrides: ContextBudgetOverrides = {},
): ContextBudgetConfig {
  const cfg = readConfig();
  const canonical = canonicalModelRef(modelRef);
  const metadata = resolveModelMetadata(canonical);
  const configuredModelWindows = cfg?.system?.contextWindowTokensByModel;
  const configWindowByModel = configuredModelWindows && typeof configuredModelWindows === "object"
    ? positiveInteger(configuredModelWindows[canonical])
    : null;
  const envWindow = positiveInteger(process.env.BUTLER_CONTEXT_WINDOW_TOKENS);
  const configWindow = positiveInteger(cfg?.system?.contextWindowTokens);
  const overrideWindowByModel = overrides.modelWindows?.[canonical];
  const contextWindowTokens =
    positiveInteger(overrides.contextWindowTokens) ??
    positiveInteger(overrideWindowByModel) ??
    envWindow ??
    configWindowByModel ??
    configWindow ??
    metadata.context_window_tokens ??
    DEFAULT_CONTEXT_WINDOW_TOKENS;

  return {
    contextWindowTokens,
    reservedOutputTokens:
      positiveInteger(overrides.reservedOutputTokens) ??
      positiveInteger(process.env.BUTLER_CONTEXT_RESERVED_OUTPUT_TOKENS) ??
      positiveInteger(cfg?.system?.contextReservedOutputTokens) ??
      defaultReservedOutputTokens(contextWindowTokens),
    reservedToolTokens:
      positiveInteger(overrides.reservedToolTokens) ??
      positiveInteger(process.env.BUTLER_CONTEXT_RESERVED_TOOL_TOKENS) ??
      positiveInteger(cfg?.system?.contextReservedToolTokens) ??
      defaultReservedToolTokens(contextWindowTokens),
    warningThresholdRatio: WARNING_THRESHOLD_RATIO,
    autoCompactThresholdRatio: AUTO_COMPACT_THRESHOLD_RATIO,
    hardThresholdRatio: HARD_THRESHOLD_RATIO,
  };
}

export function evaluateContextBudget(input: {
  modelRef?: string | null;
  inputTokens: number;
  overrides?: ContextBudgetOverrides;
}): ContextBudgetEvaluation {
  const modelRef = canonicalModelRef(input.modelRef);
  const parsed = parseModelRef(modelRef);
  const config = resolveContextBudgetConfig(modelRef, input.overrides);
  const inputTokens = Math.max(0, Math.trunc(input.inputTokens));
  const tokenEstimator = resolveModelMetadata(modelRef).token_estimator;
  const usedRatio = config.contextWindowTokens > 0 ? inputTokens / config.contextWindowTokens : 1;
  const shouldHardPressure = usedRatio >= config.hardThresholdRatio;
  const shouldAutoCompact = usedRatio >= config.autoCompactThresholdRatio;
  const shouldWarn = usedRatio >= config.warningThresholdRatio;
  const thresholdState: ContextThresholdState = shouldHardPressure
    ? "hard_pressure"
    : shouldAutoCompact
      ? "auto_compact"
      : shouldWarn
        ? "warning"
        : "normal";
  const pressureLevel: ContextPressureLevel = shouldAutoCompact || shouldHardPressure
    ? "high"
    : shouldWarn
      ? "medium"
      : "low";
  const reserve = config.reservedOutputTokens + config.reservedToolTokens;

  return {
    ...config,
    modelRef,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    inputTokens,
    tokenEstimator,
    usedRatio,
    freeTokens: Math.max(0, config.contextWindowTokens - inputTokens),
    freeTokensAfterReserve: Math.max(0, config.contextWindowTokens - reserve - inputTokens),
    thresholdState,
    pressureLevel,
    shouldWarn,
    shouldAutoCompact,
    shouldHardPressure,
  };
}

export function evaluateWorkingContextBudget(input: {
  modelRef?: string | null;
  workingContextTokens: number;
  staticContextTokens?: number;
  liveConfigurationTokens?: number;
  runtimeStateTokens?: number;
  compactionPromptReserveTokens?: number;
  overrides?: ContextBudgetOverrides;
}): WorkingContextBudgetEvaluation {
  const modelRef = canonicalModelRef(input.modelRef);
  const parsed = parseModelRef(modelRef);
  const config = resolveContextBudgetConfig(modelRef, input.overrides);
  const staticContextTokens = Math.max(0, Math.trunc(input.staticContextTokens ?? 0));
  const liveConfigurationTokens = Math.max(0, Math.trunc(input.liveConfigurationTokens ?? 0));
  const runtimeStateTokens = Math.max(0, Math.trunc(input.runtimeStateTokens ?? 0));
  const compactionPromptReserveTokens = Math.max(
    0,
    Math.trunc(
      input.compactionPromptReserveTokens ??
        positiveInteger(process.env.BUTLER_CONTEXT_COMPACTION_PROMPT_RESERVE_TOKENS) ??
        positiveInteger(readConfig()?.system?.contextCompactionPromptReserveTokens) ??
        defaultCompactionPromptReserveTokens(config.contextWindowTokens),
    ),
  );
  const reserved = config.reservedOutputTokens +
    config.reservedToolTokens +
    staticContextTokens +
    liveConfigurationTokens +
    runtimeStateTokens +
    compactionPromptReserveTokens;
  const availableWorkingContextTokens = Math.max(0, config.contextWindowTokens - reserved);
  const workingContextTokens = Math.max(0, Math.trunc(input.workingContextTokens));
  const usedWorkingRatio = availableWorkingContextTokens > 0
    ? workingContextTokens / availableWorkingContextTokens
    : 1;
  const shouldHardPressure = usedWorkingRatio >= WORKING_CONTEXT_HARD_PRESSURE_RATIO ||
    workingContextTokens > availableWorkingContextTokens;
  const shouldAutoCompact = usedWorkingRatio >= WORKING_CONTEXT_AUTO_COMPACT_RATIO;

  return {
    ...config,
    modelRef,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    tokenEstimator: resolveModelMetadata(modelRef).token_estimator,
    workingContextTokens,
    staticContextTokens,
    liveConfigurationTokens,
    runtimeStateTokens,
    compactionPromptReserveTokens,
    availableWorkingContextTokens,
    usedWorkingRatio,
    shouldAutoCompact,
    shouldHardPressure,
    usableUserMessageTokens: availableWorkingContextTokens,
  };
}

export function tokenBudgetToChars(tokens: number): number {
  return Math.max(0, Math.trunc(tokens) * 4);
}

export function trimTextToTokenBudget(text: string, maxTokens: number, options: {
  from?: "start" | "end";
  marker?: string;
} = {}): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (estimateContextTokens(trimmed) <= maxTokens) return trimmed;
  const marker = options.marker ?? "[...trimmed for context budget...]";
  const maxChars = Math.max(0, tokenBudgetToChars(maxTokens) - marker.length - 2);
  if (maxChars <= 0) return marker;
  if (options.from === "start") {
    return `${trimmed.slice(0, maxChars).trimEnd()}\n${marker}`;
  }
  return `${marker}\n${trimmed.slice(Math.max(0, trimmed.length - maxChars)).trimStart()}`;
}

export function takeLinesFromEndWithinBudget(lines: string[], maxTokens: number): string[] {
  const selected: string[] = [];
  let usedTokens = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const lineTokens = estimateContextTokens(line);
    if (selected.length === 0 && lineTokens > maxTokens) {
      selected.unshift(trimTextToTokenBudget(line, maxTokens));
      break;
    }
    if (usedTokens + lineTokens > maxTokens) {
      const remainingTokens = maxTokens - usedTokens;
      if (remainingTokens >= 120) {
        selected.unshift(trimTextToTokenBudget(line, remainingTokens));
      }
      break;
    }
    selected.unshift(line);
    usedTokens += lineTokens;
  }
  return selected;
}

export function defaultRecentConversationTokenBudget(modelRef?: string | null): number {
  const config = resolveContextBudgetConfig(modelRef);
  return Math.max(2_000, Math.min(16_000, Math.floor(config.contextWindowTokens * 0.05)));
}
