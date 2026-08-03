import type { ModelRoundTool } from "../../../agent/btcc/ports/model-round.ts";
import type { ButlerRuntime, OpenAIPromptCacheConfig, PromptCachePolicySummary, PromptCacheRetention, ReasoningEffort, RuntimeControlPlaneSummary } from "../runtime-contracts.ts";
import { DEFAULT_CODEX_MODEL } from "./models.ts";
import { configuredDefaultModelRef } from "../shared/model-routing.ts";
import { createHash } from "crypto";
import { getButlerData, getButlerHome, readConfig } from "../shared/runtime-support.ts";
import { homedir } from "os";
import { join } from "path";
import { parseModelRef } from "../model-ref.ts";




export interface OpenAIModelResolution {
  model: string;
  reasoningEffort: ReasoningEffort;
}




export const DEFAULT_OPENAI_MODEL = DEFAULT_CODEX_MODEL;



export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";



export const DEFAULT_WORKER_TOOL_ROUNDS = 24;



export const WORKER_ACTIVITY_HEARTBEAT_MS = 30_000;



export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;



export const MAX_TOOL_TIMEOUT_MS = 900_000;




export const LEGACY_MODEL_MAP: Array<{
  match: RegExp;
  model: string;
  reasoningEffort: ReasoningEffort;
}> = [];




export const SHELL_TOOL: ModelRoundTool = {
  name: "run_shell",
  description:
    "Run a single non-interactive command in the local project workspace through Butler's platform-neutral command executor. Prefer cross-platform executables with explicit arguments, rg for search, and structured extraction or case-insensitive matching for config, script, or log questions.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        description: "The command to execute. Prefer one executable with explicit arguments and avoid shell-dialect-specific syntax.",
      },
      timeout_ms: {
        type: "integer",
        description: "Optional timeout in milliseconds. Keep it as low as practical.",
      },
      justification: {
        type: "string",
        description: "Short note about why this command is needed.",
      },
    },
    required: ["command"],
  },
};




export function augmentedPath(): string {
  const entries = [
    join(homedir(), ".local", "bin"),
    join(homedir(), ".bun", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    process.env.PATH || "",
  ].filter(Boolean);
  return Array.from(new Set(entries)).join(":");
}




export function normalizeRuntime(value: unknown): ButlerRuntime | null {
  if (value === "codex-api") return value;
  if (value === "local") return value;
  return null;
}




export function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  if (value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
    return value;
  }
  return null;
}




export function normalizePromptCacheRetention(value: unknown): PromptCacheRetention | null {
  if (value === "in_memory" || value === "24h") return value;
  return null;
}




export function getButlerRuntime(): ButlerRuntime {
  const envRuntime = normalizeRuntime(process.env.BUTLER_RUNTIME);
  if (envRuntime) return envRuntime;
  const configRuntime = normalizeRuntime(readConfig()?.system?.runtime);
  return configRuntime ?? "codex-api";
}




export function canonicalizeRequestedModel(requested: string): string {
  const parsed = parseModelRef(requested);
  if (parsed.source === "namespaced") {
    return parsed.modelId;
  }
  return requested;
}




export function resolveConfiguredOpenAIModel(): string {
  const cfg = readConfig();
  const envModel = process.env.BUTLER_OPENAI_MODEL?.trim();
  if (envModel) return envModel;

  const configModel = cfg?.system?.openaiModel;
  if (typeof configModel === "string" && configModel.trim()) return configModel.trim();

  const legacyModel = cfg?.system?.workerModel ?? cfg?.system?.defaultModel;
  if (typeof legacyModel === "string" && legacyModel.trim()) {
    return mapRequestedOpenAIModel(
      canonicalizeRequestedModel(legacyModel.trim()),
      DEFAULT_REASONING_EFFORT,
    ).model;
  }

  return DEFAULT_OPENAI_MODEL;
}




export function resolveConfiguredReasoningEffort(): ReasoningEffort {
  const cfg = readConfig();
  const envEffort = normalizeReasoningEffort(process.env.BUTLER_OPENAI_REASONING_EFFORT);
  if (envEffort) return envEffort;

  const configEffort = normalizeReasoningEffort(cfg?.system?.openaiReasoningEffort);
  if (configEffort) return configEffort;

  const legacyModel = cfg?.system?.workerModel ?? cfg?.system?.defaultModel;
  if (typeof legacyModel === "string" && legacyModel.trim()) {
    return mapRequestedOpenAIModel(
      canonicalizeRequestedModel(legacyModel.trim()),
      DEFAULT_REASONING_EFFORT,
    ).reasoningEffort;
  }

  return DEFAULT_REASONING_EFFORT;
}




export function sanitizePromptCacheSegment(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-:]+|[-:]+$/g, "");
}




export function resolveConfiguredPromptCacheKeyPrefix(): string | null {
  const cfg = readConfig();
  const envPrefix = sanitizePromptCacheSegment(process.env.BUTLER_OPENAI_PROMPT_CACHE_KEY_PREFIX || "");
  if (envPrefix) return envPrefix;

  const configPrefix = cfg?.system?.openaiPromptCacheKeyPrefix;
  if (typeof configPrefix === "string") {
    const normalized = sanitizePromptCacheSegment(configPrefix);
    if (normalized) return normalized;
  }

  return defaultPromptCacheKeyPrefix();
}




export function resolveConfiguredPromptCacheRetention(): PromptCacheRetention {
  const cfg = readConfig();
  const envRetention = normalizePromptCacheRetention(process.env.BUTLER_OPENAI_PROMPT_CACHE_RETENTION);
  if (envRetention) return envRetention;

  return normalizePromptCacheRetention(cfg?.system?.openaiPromptCacheRetention) ?? "24h";
}




export function defaultPromptCacheKeyPrefix(): string {
  const stableInput = [getButlerHome(), getButlerData()].join("|");
  const digest = createHash("sha256").update(stableInput).digest("hex").slice(0, 12);
  return `butler:${digest}`;
}




export function mapRequestedOpenAIModel(
  requested: string,
  fallbackEffort: ReasoningEffort,
): OpenAIModelResolution {
  const normalizedRequested = canonicalizeRequestedModel(requested);
  for (const legacy of LEGACY_MODEL_MAP) {
    if (legacy.match.test(normalizedRequested)) {
      return {
        model: legacy.model,
        reasoningEffort: legacy.reasoningEffort,
      };
    }
  }

  return {
    model: normalizedRequested,
    reasoningEffort: fallbackEffort,
  };
}




export function resolveOpenAIModel(
  model?: string,
  reasoningEffort?: ReasoningEffort,
): OpenAIModelResolution {
  const fallbackEffort = reasoningEffort ?? resolveConfiguredReasoningEffort();
  const requested = model?.trim();
  if (!requested) {
    return {
      model: resolveConfiguredOpenAIModel(),
      reasoningEffort: fallbackEffort,
    };
  }

  return mapRequestedOpenAIModel(requested, fallbackEffort);
}




export function resolveWorkerShellOpenAIModel(model?: string): OpenAIModelResolution {
  const requested = model?.trim();
  if (requested) {
    if (isOpenAIToolRunnerModelRef(requested)) {
      return resolveOpenAIModel(requested);
    }
  }

  const cfg = readConfig();
  const candidates = [
    process.env.BUTLER_OPENAI_MODEL,
    cfg?.system?.openaiModel,
    cfg?.system?.workerModel,
    cfg?.system?.butlerModel,
    cfg?.system?.defaultModel,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    if (!isOpenAIToolRunnerModelRef(candidate.trim())) continue;
    return mapRequestedOpenAIModel(
      canonicalizeRequestedModel(candidate.trim()),
      resolveConfiguredReasoningEffort(),
    );
  }

  return {
    model: DEFAULT_OPENAI_MODEL,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
  };
}




export function isOpenAIToolRunnerModelRef(value: string): boolean {
  const trimmed = value.trim();
  const parsed = parseModelRef(trimmed);
  if (parsed.providerId === "local") return false;
  if (parsed.source === "namespaced") return parsed.providerId === "openai";
  return parsed.providerId === "openai" || /^auto:codex-latest$/iu.test(trimmed);
}




export function resolveOpenAIPromptCacheConfig(scope?: string): OpenAIPromptCacheConfig {
  const config: OpenAIPromptCacheConfig = {};
  const keyPrefix = resolveConfiguredPromptCacheKeyPrefix();
  const retention = resolveConfiguredPromptCacheRetention();
  const normalizedScope = scope ? sanitizePromptCacheSegment(scope) : "";

  if (keyPrefix) {
    config.prompt_cache_key = [keyPrefix, normalizedScope].filter(Boolean).join(":");
  }
  if (retention) {
    config.prompt_cache_retention = retention;
  }

  return config;
}




export function resolvePromptCachePolicy(scope?: string): PromptCachePolicySummary {
  const keyPrefix = resolveConfiguredPromptCacheKeyPrefix();
  const retention = resolveConfiguredPromptCacheRetention();

  const config = resolveOpenAIPromptCacheConfig(scope);
  return {
    supported: true,
    configured: Boolean(keyPrefix || retention),
    keyPrefix,
    retention,
    effectiveKey: config.prompt_cache_key ?? null,
    scope: scope ?? null,
  };
}




export function getRuntimeControlPlaneSummary(options: { model?: string; cacheScope?: string } = {}): RuntimeControlPlaneSummary {
  const requested = options.model?.trim() || configuredDefaultModelRef();
  const parsedRequested = requested ? parseModelRef(requested) : null;
  const runtime: ButlerRuntime = parsedRequested?.providerId === "local" ? "local" : getButlerRuntime();
  const rawModel = parsedRequested?.providerId === "local" ? parsedRequested.canonicalRef : resolveOpenAIModel(options.model).model;
  const parsed = parseModelRef(rawModel);

  return {
    runtime,
    rawModel,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    modelRef: parsed.canonicalRef,
    promptCache: resolvePromptCachePolicy(options.cacheScope),
  };
}
