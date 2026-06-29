import { appendFileSync, existsSync, readFileSync } from "fs";
import { spawn } from "child_process";
import { basename, join } from "path";
import { arch, homedir, platform, release } from "os";
import { appendPromptCacheMetric } from "./prompt-cache-metrics.ts";
import { readLocalModelConfigs, type LocalModelConfig } from "./local-models.ts";
import { parseModelRef } from "./model-ref.ts";
import {
  resolveOpenAIAuth,
  resolveOpenAICodexAuth,
  type OpenAIAuthMode,
} from "./openai-auth.ts";
import { DEFAULT_CODEX_MODEL, resolveDynamicOpenAIModel } from "./openai-models.ts";
import { defaultHostedProviderApiBaseUrl } from "./model-catalog.ts";
import {
  readRegisteredHostedModelConfigs,
  resolveProviderCredentialSecret,
  type HostedModelProviderId,
  type RegisteredHostedModelConfig,
} from "./registered-models.ts";
import {
  runAgentLoop,
  type AgentLoopMessage,
  type AgentLoopModelResponse,
  type AgentLoopToolDefinition,
} from "../../agent/turn/agent-loop.ts";
import {
  estimateContextTokens,
} from "../../agent/context/budget.ts";
import { cognitionMemoryRoot } from "../../agent/cognition/paths.ts";
import { budgetToolOutput } from "../../agent/context/tool-output-budgeter.ts";
import type { AttachmentRef } from "../../test-support/harness/contracts.ts";
import {
  attachmentImageDataUrl,
  promptWithAttachmentContext,
} from "../../agent/context/attachment-context.ts";
import { butlerAgentResourcesPath } from "../../runtime/paths.ts";
import { resolveRuntimeMessageLanguage, type RuntimeMessageLanguage } from "../../agent/output/messages.ts";
import {
  ModelProviderRequestError,
  providerEmptyResponseError,
  providerHttpError,
  providerNetworkError,
  safeEndpointLabel,
} from "./provider-errors.ts";

export type ButlerRuntime = "codex-api" | "local";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
export type PromptCacheRetention = "in_memory" | "24h";

export interface PromptUsageSectionAttribution {
  id: string;
  chars: number;
  estimatedTokens: number;
}

export interface PromptUsageBudgetState {
  status: "ok" | "warning" | "exhausted";
  requestCount: number;
  maxRequests: number;
  promptTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  maxPromptTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  stopReason?: string;
}

export interface PromptUsageAttribution {
  turnId?: string;
  phase?: string;
  roundIndex?: number;
  reasoningEffort?: ReasoningEffort;
  budgetState?: PromptUsageBudgetState;
  getBudgetState?: () => PromptUsageBudgetState;
  beforeModelRequest?: (input: {
    roundIndex: number;
    phase?: string;
  }) => void;
  afterModelResponseUsage?: (usage: PromptUsageReport & {
    outputTokens: number;
    roundIndex: number;
  }) => void;
  promptSections?: PromptUsageSectionAttribution[];
}

interface PromptOptions {
  prompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  instructions?: string;
  cacheScope?: string;
  signal?: AbortSignal;
  attachments?: AttachmentRef[];
  butlerData?: string;
  usageAttribution?: PromptUsageAttribution;
}

interface WorkerOptions {
  taskDir: string;
  projectPath: string;
  model?: string;
  log?: (line: string) => void;
  onActivity?: WorkerActivityHandler;
}

interface ShellTaskOptions {
  prompt: string;
  projectPath: string;
  taskDir?: string;
  model?: string;
  instructions?: string;
  cacheScope?: string;
  log?: (line: string) => void;
  onActivity?: WorkerActivityHandler;
  messageLanguage?: RuntimeMessageLanguage;
  maxToolRounds?: number;
}

export type WorkerActivityPhase =
  | "planning"
  | "executing"
  | "verifying"
  | "consolidating"
  | "reporting";

export type WorkerActivitySemanticPhase =
  | "orienting"
  | "planning"
  | "inspecting"
  | "executing"
  | "verifying"
  | "committing"
  | "consolidating"
  | "reporting"
  | "blocked";

export type WorkerActivityActionKind =
  | "read_file"
  | "search"
  | "list_files"
  | "run_command"
  | "write_file"
  | "edit_file"
  | "apply_patch"
  | "git_status"
  | "git_diff"
  | "test"
  | "typecheck"
  | "commit"
  | "report"
  | "unknown";

export interface WorkerActivityUpdate {
  /**
   * Legacy compact projection phase. Keep for existing UI consumers; do not
   * treat this as the semantic source of truth for Worker/Steward timelines.
   */
  phase: WorkerActivityPhase;
  /** Semantic state-machine phase. This is intentionally separate from tool or command kind. */
  semanticPhase?: WorkerActivitySemanticPhase;
  /** Safe action/tool classification used inside the semantic phase. */
  actionKind?: WorkerActivityActionKind;
  statusLine: string;
  currentTitle?: string;
  workBlock?: WorkerActivityWorkBlockUpdate;
}

type WorkerActivityHandler = (update: WorkerActivityUpdate) => void | Promise<void>;

export interface WorkerActivityProgressDetailRow {
  id: string;
  kind?: string;
  safe_label: string;
  safe_value?: string;
  state?: string;
}

export interface WorkerActivityProgressRow {
  id: string;
  kind: string;
  safe_label: string;
  state: string;
  safe_tool_name?: string;
  safe_input_label?: string;
  tool_call_id?: string;
  work_block_id?: string;
  work_block_label?: string;
  safe_detail_rows?: WorkerActivityProgressDetailRow[];
  created_at?: string;
}

export interface WorkerActivityWorkBlockUpdate {
  id: string;
  label: string;
  state: string;
  rows: WorkerActivityProgressRow[];
  created_at?: string;
}

export function formatWorkerActivityElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0 || minutes >= 5) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

export function workerPlanningStatusLine(elapsedMs: number): string {
  if (elapsedMs <= 0) return "Planning: choosing the worker step path.";
  return `Planning: still choosing the worker step path (${formatWorkerActivityElapsed(elapsedMs)}).`;
}

export function workerEvidenceStatusLine(elapsedMs: number): string {
  if (elapsedMs <= 0) return "Consolidating: reading worker evidence.";
  return `Consolidating: still reading worker evidence (${formatWorkerActivityElapsed(elapsedMs)}).`;
}

export function workerReportingStatusLine(elapsedMs: number): string {
  if (elapsedMs <= 0) return "Reporting: composing the worker result.";
  return `Reporting: still composing the worker result (${formatWorkerActivityElapsed(elapsedMs)}).`;
}

export interface FunctionToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface FunctionToolCall {
  call_id: string;
  name: string;
  arguments: string;
}

export interface FunctionToolPromptOptions {
  prompt: string;
  model?: string;
  instructions?: string;
  cacheScope?: string;
  signal?: AbortSignal;
  attachments?: AttachmentRef[];
  butlerData?: string;
  usageAttribution?: PromptUsageAttribution;
  tools: FunctionToolDefinition[];
  dynamicTools?: () => readonly FunctionToolDefinition[];
  maxToolRounds?: number;
  log?: (line: string) => void;
  onAssistantTextBeforeTools?: (input: {
    text: string;
    toolCalls: Array<{
      name: string;
      args: Record<string, unknown>;
    }>;
  }) => Promise<void> | void;
  executeTool: (call: {
    name: string;
    args: Record<string, unknown>;
    rawArguments: string;
  }) => Promise<unknown>;
  finalTextFromToolResult?: (input: {
    name: string;
    args: Record<string, unknown>;
    output: unknown;
  }) => Promise<string | null | undefined> | string | null | undefined;
}

interface OpenAIModelResolution {
  model: string;
  reasoningEffort: ReasoningEffort;
}

interface HostedRuntimeConfig {
  providerId: HostedModelProviderId;
  modelId: string;
  modelRef: `${HostedModelProviderId}/${string}`;
  authType: "api_key" | "codex_oauth";
  apiKey?: string;
  apiBaseUrl?: string;
}

interface OpenAIAuthOverride {
  authorization: string;
  mode: OpenAIAuthMode;
}

interface OpenAIResponse {
  id: string;
  output?: Array<Record<string, any>>;
  output_text?: string;
  usage?: {
    input_tokens?: number;
    prompt_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

export interface OpenAIPromptCacheConfig {
  prompt_cache_key?: string;
  prompt_cache_retention?: PromptCacheRetention;
}

export interface PromptCacheStats {
  promptTokens: number | null;
  cachedTokens: number;
  totalTokens: number | null;
}

export interface PromptUsageReport {
  model: string;
  promptTokens: number | null;
  cachedTokens: number;
  totalTokens: number | null;
  outputTokens: number;
}

export interface PromptTextResult {
  text: string;
  model: string;
  usage: PromptUsageReport | null;
}

export interface PromptCachePolicySummary {
  supported: boolean;
  configured: boolean;
  keyPrefix: string | null;
  retention: PromptCacheRetention | null;
  effectiveKey: string | null;
  scope: string | null;
}

export interface RuntimeControlPlaneSummary {
  runtime: ButlerRuntime;
  rawModel: string;
  providerId: string;
  modelId: string;
  modelRef: string;
  promptCache: PromptCachePolicySummary;
}

export interface OpenAIAuthSummary {
  mode: OpenAIAuthMode;
  envKey: "OPENAI_API_KEY" | "BUTLER_CODEX_AUTH_PROFILE" | "CODEX_AUTH_JSON";
}

const DEFAULT_OPENAI_MODEL = DEFAULT_CODEX_MODEL;
const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";
const MAX_TOOL_ROUNDS = 60;
const DEFAULT_WORKER_TOOL_ROUNDS = 24;
const WORKER_ACTIVITY_HEARTBEAT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const MAX_TOOL_TIMEOUT_MS = 900_000;
const DEFAULT_MODEL_API_RETRY_ATTEMPTS = 3;
const DEFAULT_MODEL_API_RETRY_DELAY_MS = 750;

const LEGACY_MODEL_MAP: Array<{
  match: RegExp;
  model: string;
  reasoningEffort: ReasoningEffort;
}> = [];

const SHELL_TOOL = {
  type: "function",
  name: "run_shell",
  description:
    "Run a single non-interactive shell command in the local project workspace. Prefer rg for search, structured extraction or case-insensitive matching for config/script/log questions, and standard shell-safe edit patterns for file changes.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute in bash.",
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
} as const;

function readConfig(): Record<string, any> {
  const configPath = join(getButlerData(), "butler.config.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function getButlerHome(): string {
  return process.env.BUTLER_HOME || process.cwd();
}

function getButlerData(): string {
  return process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function openAIInputWithAttachments(prompt: string, attachments?: AttachmentRef[]): unknown {
  const imageParts = (attachments ?? [])
    .map((attachment) => attachmentImageDataUrl(attachment))
    .filter((url): url is string => Boolean(url))
    .map((imageUrl) => ({
      type: "input_image",
      image_url: imageUrl,
    }));
  const text = promptWithAttachmentContext(prompt, attachments);
  if (imageParts.length === 0) return text;
  return [{
    role: "user",
    content: [
      {
        type: "input_text",
        text,
      },
      ...imageParts,
    ],
  }];
}

function localUserContentWithAttachments(prompt: string, attachments?: AttachmentRef[]): string | Array<Record<string, unknown>> {
  const imageParts = (attachments ?? [])
    .map((attachment) => attachmentImageDataUrl(attachment))
    .filter((url): url is string => Boolean(url))
    .map((url) => ({
      type: "image_url",
      image_url: { url },
    }));
  const text = promptWithAttachmentContext(prompt, attachments);
  if (imageParts.length === 0) return text;
  return [
    {
      type: "text",
      text,
    },
    ...imageParts,
  ];
}

function augmentedPath(): string {
  const entries = [
    join(homedir(), ".local", "bin"),
    join(homedir(), ".bun", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    process.env.PATH || "",
  ].filter(Boolean);
  return Array.from(new Set(entries)).join(":");
}

function normalizeRuntime(value: unknown): ButlerRuntime | null {
  if (value === "codex-api") return value;
  if (value === "local") return value;
  return null;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  if (value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  return null;
}

function normalizePromptCacheRetention(value: unknown): PromptCacheRetention | null {
  if (value === "in_memory" || value === "24h") return value;
  return null;
}

export function getButlerRuntime(): ButlerRuntime {
  const envRuntime = normalizeRuntime(process.env.BUTLER_RUNTIME);
  if (envRuntime) return envRuntime;
  const configRuntime = normalizeRuntime(readConfig()?.system?.runtime);
  return configRuntime ?? "codex-api";
}

function canonicalizeRequestedModel(requested: string): string {
  const parsed = parseModelRef(requested);
  if (parsed.source === "namespaced") {
    return parsed.modelId;
  }
  return requested;
}

function resolveConfiguredOpenAIModel(): string {
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

function resolveConfiguredReasoningEffort(): ReasoningEffort {
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

function sanitizePromptCacheSegment(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-:]+|[-:]+$/g, "");
}

function resolveConfiguredPromptCacheKeyPrefix(): string | null {
  const cfg = readConfig();
  const envPrefix = sanitizePromptCacheSegment(process.env.BUTLER_OPENAI_PROMPT_CACHE_KEY_PREFIX || "");
  if (envPrefix) return envPrefix;

  const configPrefix = cfg?.system?.openaiPromptCacheKeyPrefix;
  if (typeof configPrefix === "string") {
    const normalized = sanitizePromptCacheSegment(configPrefix);
    if (normalized) return normalized;
  }

  return null;
}

function resolveConfiguredPromptCacheRetention(): PromptCacheRetention | null {
  const cfg = readConfig();
  const envRetention = normalizePromptCacheRetention(process.env.BUTLER_OPENAI_PROMPT_CACHE_RETENTION);
  if (envRetention) return envRetention;

  return normalizePromptCacheRetention(cfg?.system?.openaiPromptCacheRetention);
}

function mapRequestedOpenAIModel(
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

function resolveWorkerShellOpenAIModel(model?: string): OpenAIModelResolution {
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

function isOpenAIToolRunnerModelRef(value: string): boolean {
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

export function getOpenAIAuthSummary(): OpenAIAuthSummary {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (apiKey) {
    return {
      mode: "api_key",
      envKey: "OPENAI_API_KEY",
    };
  }

  if (existsSync(process.env.BUTLER_CODEX_AUTH_PROFILE || process.env.BUTLER_OPENAI_AUTH_PROFILE || join(getButlerData(), "auth", "openai-codex.json"))) {
    return {
      mode: "codex_subscription",
      envKey: "BUTLER_CODEX_AUTH_PROFILE",
    };
  }

  if (existsSync(process.env.CODEX_AUTH_JSON || join(homedir(), ".codex", "auth.json"))) {
    return {
      mode: "codex_oauth",
      envKey: "CODEX_AUTH_JSON",
    };
  }

  throw new Error(
    "Codex subscription login or OPENAI_API_KEY is required when BUTLER_RUNTIME=codex-api",
  );
}

function getResponsesUrl(): string {
  const base = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  return base.endsWith("/responses") ? base : `${base}/responses`;
}

function getCodexResponsesUrl(): string {
  const base = (process.env.BUTLER_CODEX_BASE_URL?.trim() || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
  if (base.endsWith("/codex/responses")) return base;
  if (base.endsWith("/codex")) return `${base}/responses`;
  return `${base}/codex/responses`;
}

function getCodexOriginator(): string {
  return process.env.BUTLER_CODEX_OAUTH_ORIGINATOR?.trim() ||
    process.env.BUTLER_OPENAI_OAUTH_ORIGINATOR?.trim() ||
    "butler";
}

function getCodexUserAgent(): string {
  return process.env.BUTLER_CODEX_USER_AGENT?.trim() ||
    `butler (${platform()} ${release()}; ${arch()})`;
}

function buildReasoningConfig(
  resolution: OpenAIModelResolution,
): { effort: Exclude<ReasoningEffort, "none"> } | undefined {
  if (resolution.reasoningEffort === "none") return undefined;
  return { effort: resolution.reasoningEffort };
}

function modelApiRetryAttempts(): number {
  const raw = Number(process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS);
  if (!Number.isFinite(raw)) return DEFAULT_MODEL_API_RETRY_ATTEMPTS;
  return Math.max(1, Math.min(5, Math.trunc(raw)));
}


function workerTracePath(taskDir: string | undefined): string | null {
  return taskDir ? join(taskDir, "worker_observability.jsonl") : null;
}

function compactTraceValue(input: unknown, max = 800): unknown {
  if (typeof input === "string") return input.replace(/\s+/g, " ").trim().slice(0, max);
  if (input === null || input === undefined) return input;
  try {
    const text = JSON.stringify(input);
    return text.length > max ? `${text.slice(0, max)}…` : input;
  } catch {
    return String(input).slice(0, max);
  }
}

function writeWorkerTrace(taskDir: string | undefined, event: string, data: Record<string, unknown> = {}): void {
  const path = workerTracePath(taskDir);
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`, "utf8");
  } catch {
    // Observability is best-effort; provider execution remains primary.
  }
}

function modelApiRetryDelayMs(attemptIndex: number): number {
  const raw = Number(process.env.BUTLER_MODEL_API_RETRY_DELAY_MS);
  const base = Number.isFinite(raw) ? Math.max(0, raw) : DEFAULT_MODEL_API_RETRY_DELAY_MS;
  return Math.min(5_000, base * 2 ** Math.max(0, attemptIndex));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("Runtime turn was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function isTransientModelApiError(error: unknown): boolean {
  if (error instanceof ModelProviderRequestError) return error.retryable;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:OpenAI Responses API error|Codex backend error) \((?:429|5\d\d)\)/i.test(message) ||
    /\bserver_error\b/i.test(message) ||
    /upstream connect error|disconnect\/reset|connection termination|ECONNRESET|ETIMEDOUT|ECONNRESET|fetch failed/i
      .test(message);
}

async function createOpenAIResponse(
  body: Record<string, any>,
  signal?: AbortSignal,
  authOverride?: OpenAIAuthOverride,
): Promise<OpenAIResponse> {
  const attempts = modelApiRetryAttempts();
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      throwIfAborted(signal);
      return await createOpenAIResponseOnce(body, signal, authOverride);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw abortError();
      if (attempt >= attempts - 1 || !isTransientModelApiError(error)) {
        throw error;
      }
      await sleep(modelApiRetryDelayMs(attempt), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function createOpenAIResponseOnce(
  body: Record<string, any>,
  signal?: AbortSignal,
  authOverride?: OpenAIAuthOverride,
): Promise<OpenAIResponse> {
  const auth = authOverride ?? await resolveOpenAIAuth();
  if (auth.mode === "codex_subscription" || auth.mode === "codex_oauth") {
    return await createCodexResponse(body, auth.authorization, signal);
  }
  const { __butler_codex_stateless_input: _codexStatelessInput, ...officialBody } = body;
  const endpoint = safeEndpointLabel(getResponsesUrl());
  const model = typeof officialBody.model === "string" ? officialBody.model : undefined;

  let response: Response;
  try {
    response = await fetch(getResponsesUrl(), {
      method: "POST",
      headers: {
        Authorization: auth.authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(officialBody),
      signal,
    });
  } catch (error) {
    throw providerNetworkError({
      provider: "openai",
      api: "responses",
      endpoint,
      model,
      error,
    });
  }

  if (!response.ok) {
    const raw = await response.text();
    let detail = raw;
    try {
      const parsed = JSON.parse(raw);
      detail = parsed?.error?.message || raw;
    } catch {}
    throw providerHttpError({
      provider: "openai",
      api: "responses",
      statusCode: response.status,
      detail,
      endpoint,
      model,
    });
  }

  return (await response.json()) as OpenAIResponse;
}

function decodeJwtPayload(token: string): Record<string, any> | null {
  const rawToken = token.replace(/^Bearer\s+/i, "");
  const part = rawToken.split(".")[1];
  if (!part) return null;
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function codexAccountIdFromAuthorization(authorization: string): string {
  const payload = decodeJwtPayload(authorization);
  const auth = payload?.["https://api.openai.com/auth"];
  const accountId = auth && typeof auth === "object"
    ? (auth.chatgpt_account_id || auth.account_id)
    : undefined;
  if (typeof accountId === "string" && accountId) return accountId;
  throw new Error("Codex subscription token did not include a ChatGPT account id");
}

function codexRequestBody(body: Record<string, any>): Record<string, any> {
  const rawInput = body.__butler_codex_stateless_input ?? body.input;
  const next: Record<string, any> = {
    ...body,
    model: codexSubscriptionModel(String(body.model || "")),
    instructions: typeof body.instructions === "string" && body.instructions.trim()
      ? body.instructions
      : "You are Butler, a helpful personal AI assistant.",
    input: codexInput(rawInput),
    store: false,
    stream: true,
  };
  delete next.previous_response_id;
  delete next.__butler_codex_stateless_input;
  delete next.prompt_cache_retention;
  if (!next.text) {
    next.text = { verbosity: "medium" };
  }
  return next;
}

function codexSubscriptionModel(model: string): string {
  const trimmed = model.trim();
  if (/^gpt-\d+(?:\.\d+)*-codex$/i.test(trimmed)) {
    return trimmed.replace(/-codex$/i, "");
  }
  if (!trimmed) {
    throw new Error("Codex subscription model is required; no model fallback is allowed.");
  }
  return trimmed;
}

function codexInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  return [{
    role: "user",
    content: [{
      type: "input_text",
      text: input,
    }],
  }];
}

function toCodexStatelessInput(input: unknown): Array<Record<string, unknown>> {
  const converted = codexInput(input);
  return Array.isArray(converted)
    ? converted.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
}

function functionCallContinuationItems(
  response: OpenAIResponse,
  allowedNames?: Set<string>,
): Array<Record<string, unknown>> {
  return getFunctionCalls(response, allowedNames).map((call) => ({
    type: "function_call",
    call_id: call.call_id,
    name: call.name,
    arguments: call.arguments,
  }));
}

function parseSseEvents(text: string): Record<string, any>[] {
  const events: Record<string, any>[] = [];
  for (const chunk of text.split(/\r?\n\r?\n/)) {
    const data = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object") events.push(parsed);
    } catch {
      // Ignore non-JSON keepalive frames.
    }
  }
  return events;
}

function codexResponseFromSse(text: string): OpenAIResponse {
  const output: Array<Record<string, any>> = [];
  let completed: Record<string, any> | null = null;
  let fallbackText = "";

  for (const event of parseSseEvents(text)) {
    if (event.type === "error") {
      throw new Error(`Codex backend error: ${event.message || event.code || JSON.stringify(event)}`);
    }
    if (event.type === "response.failed") {
      const error = event.response?.error;
      throw new Error(`Codex backend error: ${error?.message || error?.code || JSON.stringify(event.response)}`);
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      fallbackText += event.delta;
      continue;
    }
    if (event.type === "response.output_item.done" && event.item && typeof event.item === "object") {
      output.push(event.item);
      continue;
    }
    if (event.type === "response.completed" && event.response && typeof event.response === "object") {
      completed = event.response;
    }
  }

  if (output.length === 0 && Array.isArray(completed?.output)) {
    output.push(...completed.output);
  }

  const usage = completed?.usage;
  return {
    id: typeof completed?.id === "string" ? completed.id : `codex-${Date.now()}`,
    output,
    output_text: fallbackText || undefined,
    usage: usage
      ? {
          input_tokens: usage.input_tokens,
          prompt_tokens: usage.input_tokens,
          total_tokens: usage.total_tokens,
          prompt_tokens_details: {
            cached_tokens: usage.input_tokens_details?.cached_tokens,
          },
        }
      : undefined,
  };
}

async function createCodexResponse(
  body: Record<string, any>,
  authorization: string,
  signal?: AbortSignal,
): Promise<OpenAIResponse> {
  const accountId = codexAccountIdFromAuthorization(authorization);
  const endpoint = safeEndpointLabel(getCodexResponsesUrl());
  const model = typeof body.model === "string" ? body.model : undefined;
  let response: Response;
  try {
    response = await fetch(getCodexResponsesUrl(), {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "OpenAI-Beta": "responses=experimental",
        "User-Agent": getCodexUserAgent(),
        "chatgpt-account-id": accountId,
        originator: getCodexOriginator(),
      },
      body: JSON.stringify(codexRequestBody(body)),
      signal,
    });
  } catch (error) {
    throw providerNetworkError({
      provider: "openai-codex",
      api: "codex_responses",
      endpoint,
      model,
      error,
    });
  }

  const raw = await response.text();
  if (!response.ok) {
    let detail = raw;
    try {
      const parsed = JSON.parse(raw);
      detail = parsed?.error?.message || raw;
    } catch {}
    throw providerHttpError({
      provider: "openai-codex",
      api: "codex_responses",
      statusCode: response.status,
      detail,
      endpoint,
      model,
    });
  }

  return codexResponseFromSse(raw);
}

export function extractResponseText(response: OpenAIResponse): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return sanitizeResponseFinalAnswerText(response.output_text);
  }

  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const content of item.content) {
        if ((content?.type === "output_text" || content?.type === "text") && typeof content.text === "string") {
          parts.push(content.text);
        }
      }
      continue;
    }
    if ((item?.type === "output_text" || item?.type === "text") && typeof item.text === "string") {
      parts.push(item.text);
    }
  }

  return sanitizeResponseFinalAnswerText(parts.join("\n"));
}

function sanitizeResponseFinalAnswerText(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  return localFinalAnswerEnvelope(text) ?? text;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function extractPromptCacheStats(response: OpenAIResponse): PromptCacheStats | null {
  const promptTokens =
    numberOrNull(response.usage?.input_tokens) ??
    numberOrNull(response.usage?.prompt_tokens);
  const totalTokens = numberOrNull(response.usage?.total_tokens);
  const cachedTokens = numberOrNull(response.usage?.prompt_tokens_details?.cached_tokens);

  if (promptTokens === null && totalTokens === null && cachedTokens === null) {
    return null;
  }

  return {
    promptTokens,
    cachedTokens: cachedTokens ?? 0,
    totalTokens,
  };
}

function logPromptCacheStats(
  response: OpenAIResponse,
  log: (line: string) => void,
  promptCache: OpenAIPromptCacheConfig,
): void {
  const stats = extractPromptCacheStats(response);
  if (!stats) return;

  const parts = [
    `responses usage: prompt_tokens=${stats.promptTokens ?? "?"}`,
    `cached_tokens=${stats.cachedTokens}`,
    `total_tokens=${stats.totalTokens ?? "?"}`,
  ];
  if (promptCache.prompt_cache_key) {
    parts.push(`prompt_cache_key=${promptCache.prompt_cache_key}`);
  }
  if (promptCache.prompt_cache_retention) {
    parts.push(`prompt_cache_retention=${promptCache.prompt_cache_retention}`);
  }
  log(parts.join(" "));
}

function recordPromptCacheMetric(
  response: OpenAIResponse,
  input: {
    model: string;
    scope: string;
    promptCache: OpenAIPromptCacheConfig;
    butlerData?: string;
    usageAttribution?: PromptUsageAttribution;
  },
): void {
  const stats = extractPromptCacheStats(response);
  if (!stats || stats.promptTokens === null) return;

  appendPromptCacheMetric({
    ts: Date.now(),
    model: input.model,
    scope: input.scope,
    turnId: input.usageAttribution?.turnId,
    phase: input.usageAttribution?.phase,
    roundIndex: input.usageAttribution?.roundIndex,
    reasoningEffort: input.usageAttribution?.reasoningEffort,
    promptTokens: stats.promptTokens,
    cachedTokens: stats.cachedTokens,
    totalTokens: stats.totalTokens,
    promptCacheKey: input.promptCache.prompt_cache_key,
    promptCacheRetention: input.promptCache.prompt_cache_retention,
    budgetState: input.usageAttribution?.getBudgetState?.() ?? input.usageAttribution?.budgetState,
    promptSections: input.usageAttribution?.promptSections,
  }, { butlerData: input.butlerData });
}

function usageReportFromStats(input: {
  model: string;
  stats: PromptCacheStats;
  roundIndex: number;
}): PromptUsageReport & { outputTokens: number; roundIndex: number } {
  const outputTokens = input.stats.totalTokens === null || input.stats.promptTokens === null
    ? 0
    : Math.max(0, input.stats.totalTokens - input.stats.promptTokens);
  return {
    model: input.model,
    promptTokens: input.stats.promptTokens,
    cachedTokens: input.stats.cachedTokens,
    totalTokens: input.stats.totalTokens,
    outputTokens,
    roundIndex: input.roundIndex,
  };
}

function beforeAttributedModelRequest(input: {
  attribution?: PromptUsageAttribution;
  roundIndex: number;
}): void {
  const budget = input.attribution?.getBudgetState?.() ?? input.attribution?.budgetState;
  if (budget && (
    budget.status === "exhausted" ||
    budget.requestCount >= budget.maxRequests
  )) {
    throw promptUsageModelCallBudgetExhaustedError();
  }
  input.attribution?.beforeModelRequest?.({
    roundIndex: input.roundIndex,
    phase: input.attribution.phase,
  });
}

function promptUsageModelCallBudgetExhaustedError(): Error & { code: string } {
  const error = Object.assign(
    new Error("Prompt usage model-call budget exhausted before provider request"),
    { code: "prompt_usage_model_call_budget_exhausted" },
  );
  error.name = "PromptUsageModelCallBudgetExhaustedError";
  return error;
}

function modelIterationLimitWithinUsageBudget(
  requestedRounds: number,
  attribution?: PromptUsageAttribution,
): number {
  const requested = Math.max(1, Math.min(requestedRounds, MAX_TOOL_ROUNDS));
  const budget = attribution?.getBudgetState?.() ?? attribution?.budgetState;
  if (!budget || !Number.isFinite(budget.requestCount) || !Number.isFinite(budget.maxRequests)) {
    return requested;
  }
  const remainingRequests = Math.max(0, budget.maxRequests - budget.requestCount);
  if (remainingRequests <= 1) return 1;
  return Math.max(1, Math.min(requested, remainingRequests - 1));
}

function afterAttributedModelResponse(input: {
  attribution?: PromptUsageAttribution;
  model: string;
  response: OpenAIResponse;
  roundIndex: number;
}): void {
  const stats = extractPromptCacheStats(input.response);
  if (!stats || stats.promptTokens === null) return;
  input.attribution?.afterModelResponseUsage?.(usageReportFromStats({
    model: input.model,
    stats,
    roundIndex: input.roundIndex,
  }));
}

function loadFileIfExists(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function buildWorkerInstructions(): string {
  const butlerHome = getButlerHome();
  const core = loadFileIfExists(butlerAgentResourcesPath(butlerHome, "prompts", "runtime-system-contract.md"));
  const worker = loadFileIfExists(butlerAgentResourcesPath(butlerHome, "prompts", "worker.md"));
  const toolContract = [
    "## Tool Contract",
    "- You have one tool named `run_shell`.",
    "- Commands execute in a non-interactive bash shell rooted at the assigned project path.",
    "- Prefer `rg` / `rg --files` for search and `sed`, `head`, `tail`, `cat` for inspection.",
    "- For config, manifest, script, log, or code searches based on user wording, prefer structured extraction or case-insensitive search before concluding absence.",
    "- You do not have a dedicated patch-edit tool. Make precise file edits with shell commands only.",
    "- Prefer targeted edits over full-file rewrites when the file is large or easy to corrupt.",
    "- Run tests and checks yourself before finishing whenever the task touches code.",
    "- Batch read-only discovery into a small number of targeted commands. Avoid broad repository scans, vendor trees, and repeated overlapping file slices.",
    "- Once the task acceptance criteria can be answered from collected evidence, stop calling tools and compose the worker report.",
  ].join("\n");

  return [core, worker, toolContract].filter(Boolean).join("\n\n");
}

function buildWorkerMemoryContextInstruction(): string {
  const butlerData = getButlerData();
  const memoryRoot = cognitionMemoryRoot(butlerData);
  const candidates = [
    join(memoryRoot, "core.md"),
    join(memoryRoot, "hot", "cache.md"),
    join(butlerData, "personas", "active.md"),
    join(butlerData, "eol.md"),
  ].filter((path) => existsSync(path));

  if (candidates.length === 0) {
    return [
      "No Butler memory context files are currently present.",
      "Do not fail the task because memory context is absent; proceed from the task description and project files.",
    ].join("\n");
  }

  return [
    "Optional Butler memory context files are available.",
    "Read only the files that are relevant to the task; if any file is missing or unreadable, continue without failing the task.",
    ...candidates.map((path) => `- ${path}`),
  ].join("\n");
}

function normalizeFunctionToolCallName(rawName: unknown, allowedNames?: Set<string>): string | null {
  if (typeof rawName !== "string") return null;
  const name = rawName.trim();
  if (!name) return null;
  if (allowedNames && !allowedNames.has(name)) return null;
  return name;
}

function getFunctionCalls(response: OpenAIResponse, allowedNames?: Set<string>): FunctionToolCall[] {
  const calls = Array.isArray(response.output) ? response.output : [];
  return calls.flatMap((item: any): FunctionToolCall[] => {
    const name = normalizeFunctionToolCallName(item?.name, allowedNames);
    if (
      item?.type !== "function_call" ||
      !name ||
      typeof item.call_id !== "string" ||
      typeof item.arguments !== "string"
    ) {
      return [];
    }
    return [{
      call_id: item.call_id,
      name,
      arguments: item.arguments,
    }];
  });
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function functionToolToAgentTool(tool: FunctionToolDefinition): AgentLoopToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as AgentLoopToolDefinition["inputSchema"],
  };
}

function stripNestedDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNestedDescriptions);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "description") continue;
    output[key] = stripNestedDescriptions(nested);
  }
  return output;
}

function modelFacingFunctionTools(tools: readonly FunctionToolDefinition[]): FunctionToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    parameters: stripNestedDescriptions(tool.parameters) as Record<string, unknown>,
  }));
}

function activeFunctionTools(options: FunctionToolPromptOptions): FunctionToolDefinition[] {
  const dynamicTools = options.dynamicTools?.();
  return modelFacingFunctionTools(dynamicTools && dynamicTools.length > 0 ? dynamicTools : options.tools);
}

function withoutDynamicTools(options: FunctionToolPromptOptions): FunctionToolPromptOptions {
  const { dynamicTools: _dynamicTools, ...rest } = options;
  return rest;
}

function newToolMessages(
  messages: AgentLoopMessage[],
  alreadySent: number,
): {
  items: Array<Record<string, unknown>>;
  sentCount: number;
} {
  const toolMessages = messages.filter((message) => message.role === "tool");
  const next = toolMessages.slice(alreadySent);
  return {
    sentCount: toolMessages.length,
    items: next.map((message) => ({
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content,
    })),
  };
}

function responseToAgentModelResponse(
  response: OpenAIResponse,
  allowedNames: Set<string>,
): AgentLoopModelResponse {
  return {
    text: extractResponseText(response) || undefined,
    raw: response,
    toolCalls: getFunctionCalls(response, allowedNames).map((call) => ({
      id: call.call_id,
      name: call.name,
      arguments: parseToolArguments(call.arguments),
    })),
  };
}

function clampTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TOOL_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_TOOL_TIMEOUT_MS, Math.trunc(value)));
}

function truncateForLog(text: string, limit = 1_200): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

function legacyWorkerActivityPhaseForSemanticPhase(
  semanticPhase: WorkerActivitySemanticPhase,
  fallback: WorkerActivityPhase,
): WorkerActivityPhase {
  switch (semanticPhase) {
    case "verifying":
      return "verifying";
    case "consolidating":
      return "consolidating";
    case "reporting":
      return "reporting";
    case "planning":
    case "orienting":
      return "planning";
    case "executing":
    case "committing":
    case "inspecting":
    case "blocked":
      return fallback;
  }
}

function applyWorkerActivitySemanticContext(
  update: WorkerActivityUpdate,
  semanticPhase?: WorkerActivitySemanticPhase,
): WorkerActivityUpdate {
  if (!semanticPhase) return update;
  return {
    ...update,
    phase: legacyWorkerActivityPhaseForSemanticPhase(semanticPhase, update.phase),
    semanticPhase,
  };
}

export function summarizeWorkerShellActivity(
  command: string,
  semanticContext: { semanticPhase?: WorkerActivitySemanticPhase } = {},
): WorkerActivityUpdate {
  const normalized = command.toLocaleLowerCase("en-US");
  const withSemanticContext = (update: WorkerActivityUpdate): WorkerActivityUpdate =>
    applyWorkerActivitySemanticContext(update, semanticContext.semanticPhase);
  if (/\bgit\s+(add|commit)\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "committing",
      actionKind: "commit",
      statusLine: "Committing: recording selected work changes.",
    });
  }
  if (/\bgit\s+(status)\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "verifying",
      semanticPhase: "verifying",
      actionKind: "git_status",
      statusLine: "Verifying: checking workspace state.",
    });
  }
  if (/\bgit\s+(diff|show|log)\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "verifying",
      semanticPhase: "verifying",
      actionKind: "git_diff",
      statusLine: "Verifying: checking workspace evidence.",
    });
  }
  if (/(^|&&|;|\|\||\s)(bun|npm|pnpm|yarn)\s+(run\s+)?(test|check|lint|typecheck)(\s|$)/u.test(normalized) || /(^|&&|;|\|\||\s)(vitest|jest|playwright|tsc)(\s|$)/u.test(normalized)) {
    const isTypecheck = /(^|&&|;|\|\||\s)(bun|npm|pnpm|yarn)\s+(run\s+)?typecheck(\s|$)/u.test(normalized) || /(^|&&|;|\|\||\s)tsc(\s|$)/u.test(normalized);
    return withSemanticContext({
      phase: "verifying",
      semanticPhase: "verifying",
      actionKind: isTypecheck ? "typecheck" : "test",
      statusLine: isTypecheck ? "Verifying: running type checks." : "Verifying: running validation checks.",
    });
  }
  if (/\b(apply_patch)\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "executing",
      actionKind: "apply_patch",
      statusLine: "Executing: applying a project patch.",
    });
  }
  if (/\b(cat|python3?|node|bun|perl|ruby|tee)\b/u.test(normalized) && /(>\s*[^&]|write_text|writefilesync|appendfilesync|sed\s+-i)/u.test(command)) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "executing",
      actionKind: "edit_file",
      statusLine: "Executing: writing project files.",
    });
  }
  if (/\b(rg|grep)\b/u.test(normalized) && !/\brg\s+--files\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "inspecting",
      actionKind: "search",
      statusLine: "Inspecting: searching project files.",
    });
  }
  if (/\b(find|ls|tree)\b/u.test(normalized) || /\brg\s+--files\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "inspecting",
      actionKind: "list_files",
      statusLine: "Inspecting: listing project files.",
    });
  }
  if (/\bpwd\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "orienting",
      actionKind: "run_command",
      statusLine: "Orienting: checking the working directory.",
    });
  }
  if (/\bwc\b/u.test(normalized)) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "inspecting",
      actionKind: "run_command",
      statusLine: "Inspecting: measuring project files.",
    });
  }
  const readableFiles = readableCommandFiles(command);
  if (readableFiles.length > 0) {
    return withSemanticContext({
      phase: "executing",
      semanticPhase: "inspecting",
      actionKind: "read_file",
      statusLine: `Inspecting: reading ${formatWorkerEvidenceSubject(readableFiles)}.`,
    });
  }
  return withSemanticContext({
    phase: "executing",
    semanticPhase: "executing",
    actionKind: "run_command",
    statusLine: "Executing: running the worker step.",
  });
}

export function summarizeWorkerShellWorkBlock(
  command: string,
  callId: string,
  language: RuntimeMessageLanguage,
  state: "running" | "delivered" | "failed" = "running",
): WorkerActivityWorkBlockUpdate {
  const title = workerCommandActivityTitle(command, language);
  const id = `worker-shell-${safeActivityToken(callId)}`;
  const inputLabel = safeWorkerCommandInputLabel(command);
  const detailLabel = language === "ko" ? "명령" : "Command";
  return {
    id,
    label: title,
    state,
    created_at: new Date().toISOString(),
    rows: [{
      id: `${id}-command`,
      kind: workerCommandProgressKind(command),
      state,
      safe_label: inputLabel ? `Bash: ${inputLabel}` : "Bash",
      safe_tool_name: "Bash",
      safe_input_label: inputLabel,
      tool_call_id: callId,
      work_block_id: id,
      work_block_label: title,
      safe_detail_rows: inputLabel
        ? [{
          id: `${id}-command-detail`,
          kind: "command",
          safe_label: detailLabel,
          safe_value: inputLabel,
          state,
        }]
        : [],
      created_at: new Date().toISOString(),
    }],
  };
}

export function workerActivityUpdateForShellCommand(
  command: string,
  callId: string,
  language: RuntimeMessageLanguage,
  semanticContext: { semanticPhase?: WorkerActivitySemanticPhase } = {},
): WorkerActivityUpdate {
  const activity = summarizeWorkerShellActivity(command, semanticContext);
  const workBlock = summarizeWorkerShellWorkBlock(command, callId, language, "running");
  return {
    ...activity,
    currentTitle: workBlock.label,
    workBlock,
  };
}

function workerCommandProgressKind(command: string): string {
  const normalized = command.toLocaleLowerCase("en-US");
  if (/\b(test|check|lint|typecheck|vitest|jest|playwright|tsc)\b/u.test(normalized)) return "ran_command";
  if (/\bgit\s+(status|diff|show|log)\b/u.test(normalized)) return "ran_command";
  if (/\b(rg|grep)\b/u.test(normalized) && !/\brg\s+--files\b/u.test(normalized)) return "searched";
  if (/\b(find|ls|tree)\b/u.test(normalized) || /\brg\s+--files\b/u.test(normalized)) return "read";
  if (readableCommandFiles(command).length > 0) return "read";
  return "ran_command";
}

function workerCommandActivityTitle(command: string, language: RuntimeMessageLanguage): string {
  const normalized = command.toLocaleLowerCase("en-US");
  const readableFiles = readableCommandFiles(command);
  if (language === "ko") {
    if (/\b(test|check|lint|typecheck|vitest|jest|playwright|tsc)\b/u.test(normalized)) {
      return "검증 명령을 실행합니다.";
    }
    if (/\bgit\s+(status|diff|show|log)\b/u.test(normalized)) return "작업 공간 상태를 확인합니다.";
    if (/\b(rg|grep)\b/u.test(normalized) && !/\brg\s+--files\b/u.test(normalized)) {
      return "파일에서 필요한 단서를 검색합니다.";
    }
    if (/\b(find|ls|tree)\b/u.test(normalized) || /\brg\s+--files\b/u.test(normalized)) {
      return "파일 목록을 확인합니다.";
    }
    if (/\bpwd\b/u.test(normalized)) return "작업 디렉터리를 확인합니다.";
    if (/\bwc\b/u.test(normalized)) return "파일 규모를 확인합니다.";
    if (readableFiles.length > 0) return `${formatWorkerEvidenceSubject(readableFiles)} 파일을 읽어 분석합니다.`;
    return "작업 명령을 실행합니다.";
  }
  if (/\b(test|check|lint|typecheck|vitest|jest|playwright|tsc)\b/u.test(normalized)) {
    return "Running validation checks.";
  }
  if (/\bgit\s+(status|diff|show|log)\b/u.test(normalized)) return "Checking workspace state.";
  if (/\b(rg|grep)\b/u.test(normalized) && !/\brg\s+--files\b/u.test(normalized)) {
    return "Searching files for needed evidence.";
  }
  if (/\b(find|ls|tree)\b/u.test(normalized) || /\brg\s+--files\b/u.test(normalized)) {
    return "Checking the file list.";
  }
  if (/\bpwd\b/u.test(normalized)) return "Checking the working directory.";
  if (/\bwc\b/u.test(normalized)) return "Measuring files.";
  if (readableFiles.length > 0) return `Reading ${formatWorkerEvidenceSubject(readableFiles)}.`;
  return "Running the worker command.";
}

function workerEvidenceActivityTitle(command: string, language: RuntimeMessageLanguage): string {
  const subject = workerEvidenceSubject(command);
  return language === "ko" ? `${subject} 근거를 정리합니다.` : `Reviewing ${subject}.`;
}

function workerReportingTitle(language: RuntimeMessageLanguage): string {
  return language === "ko" ? "워커 결과를 작성합니다." : "Composing the worker result.";
}

function safeWorkerCommandInputLabel(command: string): string {
  const text = command.replace(/\s+/gu, " ").trim();
  if (!text) return "";
  const home = homedir();
  const normalized = text.startsWith(home) ? `~/${text.slice(home.length).replace(/^\/+/u, "")}` : text;
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function safeActivityToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 80) || "command";
}

export function workerEvidenceStatusLineForCommand(command: string, elapsedMs: number): string {
  const subject = workerEvidenceSubject(command);
  if (elapsedMs <= 0) return `Consolidating: reviewing ${subject}.`;
  return `Consolidating: still reviewing ${subject} (${formatWorkerActivityElapsed(elapsedMs)}).`;
}

function workerEvidenceSubject(command: string): string {
  const normalized = command.toLocaleLowerCase("en-US");
  const readableFiles = readableCommandFiles(command);
  if (readableFiles.length > 0) return formatWorkerEvidenceSubject(readableFiles);
  if (/\b(test|check|lint|typecheck|vitest|jest|playwright|tsc)\b/u.test(normalized)) {
    return "validation output";
  }
  if (/\bgit\s+(status|diff|show|log)\b/u.test(normalized)) return "workspace state";
  if (/\b(rg|grep)\b/u.test(normalized) && !/\brg\s+--files\b/u.test(normalized)) {
    return "search results";
  }
  if (/\b(find|ls|tree)\b/u.test(normalized) || /\brg\s+--files\b/u.test(normalized)) {
    return "the file list";
  }
  if (/\bwc\b/u.test(normalized)) return "file measurements";
  if (/\bpwd\b/u.test(normalized)) return "the working directory";
  return "worker evidence";
}

function readableCommandFiles(command: string): string[] {
  const tokens = safeShellTokens(command);
  const readCommandIndex = tokens.findIndex((token) => /^(cat|nl|sed|head|tail)$/u.test(token));
  if (readCommandIndex < 0) return [];
  const files: string[] = [];
  for (const token of tokens.slice(readCommandIndex + 1)) {
    if (!token || token.startsWith("-")) continue;
    if (/\\[nrt]/u.test(token)) continue;
    if (/^\d+(?:,\d+)?[a-z]?$/iu.test(token)) continue;
    if (/^s[|/].+[|/][a-z]*$/iu.test(token)) continue;
    if (/^[|;&(){}[\]<>]$/u.test(token)) continue;
    if (/^(sort|head|tail|sed|awk|grep|rg|cat|nl|printf|echo|xargs|cut|uniq)$/u.test(token)) break;
    if (token.includes("=") && !token.includes("/") && !token.includes(".")) continue;
    const label = safePathLabel(token);
    if (label) files.push(label);
    if (files.length >= 3) break;
  }
  return [...new Set(files)];
}

function safeShellTokens(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? "").trim());
  }
  return tokens.filter(Boolean);
}

function safePathLabel(value: string): string | null {
  const withoutTrailingPunctuation = value.replace(/[,:;]+$/u, "");
  if (!looksLikePathToken(withoutTrailingPunctuation)) return null;
  const lastSegment = withoutTrailingPunctuation.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
  const cleaned = lastSegment.replace(/[^a-zA-Z0-9._@+-]/gu, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  if (!/[a-zA-Z0-9]/u.test(cleaned)) return null;
  return cleaned.slice(0, 80);
}

function looksLikePathToken(value: string): boolean {
  if (/[\\/]/u.test(value) || value.includes(".")) return true;
  return /^(README|LICENSE|CHANGELOG|Dockerfile|Makefile|Gemfile|Podfile)$/iu.test(value);
}

function formatWorkerEvidenceSubject(files: string[]): string {
  if (files.length === 1) return files[0]!;
  if (files.length === 2) return `${files[0]} and ${files[1]}`;
  return `${files[0]} and ${files.length - 1} more files`;
}

async function reportWorkerActivity(
  handler: WorkerActivityHandler | undefined,
  update: WorkerActivityUpdate,
): Promise<void> {
  await handler?.(update);
}

export async function withWorkerActivityHeartbeat<T>(
  handler: WorkerActivityHandler | undefined,
  phase: WorkerActivityPhase,
  statusLine: (elapsedMs: number) => string,
  operation: () => Promise<T>,
  intervalMs = WORKER_ACTIVITY_HEARTBEAT_MS,
): Promise<T> {
  if (!handler) return await operation();
  const startedAt = Date.now();
  const timer = setInterval(() => {
    void reportWorkerActivity(handler, {
      phase,
      statusLine: statusLine(Date.now() - startedAt),
    }).catch(() => {});
  }, intervalMs);
  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}

function finalNoToolInstructions(instructions?: string): string {
  const finalizer = [
    "## Final Answer Synthesis",
    "Do not call any more tools.",
    "Using only the available tool results and conversation context, produce the best user-facing final answer now.",
    "Wrap the final answer in exactly one `<butler_final_answer>...</butler_final_answer>` block.",
    "Do not write any draft, analysis, process notes, or commentary outside that final-answer block.",
    "Do not mention internal loop limits, tool budgets, function calls, response ids, or raw tool JSON.",
    "If the available evidence is incomplete, state the uncertainty briefly and still provide the most useful answer possible.",
    "If web search informed the answer, include concise sources from the provided results.",
    "Preserve the active persona consistently across long answers; do not drop its voice after the opening.",
  ].join("\n");
  return [instructions?.trim(), finalizer].filter(Boolean).join("\n\n");
}

function finalEnvelopeRetryInstructions(): string {
  return [
    "Your previous response did not include the required final-answer envelope.",
    "Return the user-facing final answer inside exactly one `<butler_final_answer>...</butler_final_answer>` block now.",
    "Do not include any text before or after the block.",
  ].join("\n");
}

function configuredDefaultModelRef(): string | null {
  const cfg = readConfig();
  const value = cfg?.system?.butlerModel ?? cfg?.system?.defaultModel;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isLocalModelRequest(model?: string): boolean {
  const requested = model?.trim() || configuredDefaultModelRef();
  return requested ? parseModelRef(requested).providerId === "local" : false;
}

function resolveLocalModelConfig(model?: string): LocalModelConfig {
  const requested = model?.trim() || configuredDefaultModelRef() || "";
  const parsed = parseModelRef(requested);
  const configs = readLocalModelConfigs(getButlerData());
  const match = configs.find((config) =>
    config.model_ref === parsed.canonicalRef ||
    config.model_id === parsed.modelId ||
    (!requested && config.runtime_supported),
  );
  if (!match) {
    throw new Error(`Local model is not registered: ${model || "local"}`);
  }
  if (match.api_type !== "openai_compatible") {
    throw new Error(`Unsupported local model API type: ${match.api_type}`);
  }
  return match;
}

function hostedProviderId(value: string): HostedModelProviderId | null {
  if (
    value === "openai" ||
    value === "anthropic" ||
    value === "google" ||
    value === "xai" ||
    value === "qwen" ||
    value === "kimi" ||
    value === "zai"
  ) return value;
  return null;
}

function resolveRegisteredHostedModelConfig(model?: string): RegisteredHostedModelConfig | null {
  const requested = model?.trim() || configuredDefaultModelRef() || "";
  if (!requested) return null;
  const parsed = parseModelRef(requested);
  const providerId = hostedProviderId(parsed.providerId);
  if (!providerId) return null;
  const configs = readRegisteredHostedModelConfigs(getButlerData());
  const match = configs.find((config) =>
    config.provider_id === providerId &&
    (config.model_ref === parsed.canonicalRef || config.model_id === parsed.modelId),
  );
  if (match) return match;
  if (providerId === "openai") return null;
  throw new Error(`Hosted model is not registered: ${parsed.canonicalRef}`);
}

function resolveHostedRuntimeConfig(model?: string): HostedRuntimeConfig | null {
  const registered = resolveRegisteredHostedModelConfig(model);
  if (!registered) return null;
  if (registered.auth_type === "codex_oauth") {
    return {
      providerId: registered.provider_id,
      modelId: registered.model_id,
      modelRef: registered.model_ref,
      authType: "codex_oauth",
      apiBaseUrl: registered.api_base_url,
    };
  }
  const apiKey = resolveProviderCredentialSecret(
    registered.credential_id,
    registered.provider_id,
    getButlerData(),
  );
  if (!apiKey) {
    throw new Error(`Provider API key credential is not registered for ${registered.model_ref}`);
  }
  return {
    providerId: registered.provider_id,
    modelId: registered.model_id,
    modelRef: registered.model_ref,
    authType: "api_key",
    apiKey,
    apiBaseUrl: registered.api_base_url,
  };
}

async function openAIAuthOverrideForHosted(config: HostedRuntimeConfig): Promise<OpenAIAuthOverride | undefined> {
  if (config.providerId !== "openai") return undefined;
  if (config.authType === "api_key" && config.apiKey) {
    return {
      mode: "api_key",
      authorization: `Bearer ${config.apiKey}`,
    };
  }
  return await resolveOpenAICodexAuth();
}

interface LocalChatToolCall {
  id: string;
  type?: "function";
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

interface LocalChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | Array<Record<string, unknown>>;
  tool_calls?: LocalChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

function localChatUrl(config: LocalModelConfig): string {
  return `${config.api_base_url.replace(/\/+$/u, "")}/chat/completions`;
}

function localChatTools(tools: FunctionToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function localReasoningRequestParams(config: LocalModelConfig): Record<string, unknown> {
  if (config.platform !== "llama_cpp") return {};
  const ratio = config.reasoning_budget_ratio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0) return {};
  const maxOutputTokens = Number.isFinite(config.max_output_tokens)
    ? Math.trunc(config.max_output_tokens)
    : 0;
  if (maxOutputTokens <= 0) return {};
  const budget = Math.round(maxOutputTokens * Math.min(1, ratio));
  return budget > 0 ? { thinking_budget_tokens: budget } : {};
}

function localToolArguments(raw: unknown): {
  parsed: Record<string, unknown>;
  raw: string;
} {
  if (typeof raw === "string") {
    return {
      parsed: parseToolArguments(raw),
      raw,
    };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return {
      parsed: raw as Record<string, unknown>,
      raw: JSON.stringify(raw),
    };
  }
  return {
    parsed: {},
    raw: "{}",
  };
}

const MAX_LOCAL_TEXT_TOOL_CALLS = 8;
const MAX_LOCAL_TEXT_TOOL_SCAN_LENGTH = 64_000;
const MAX_LOCAL_TEXT_TOOL_CALL_BODY_LENGTH = 20_000;
const MAX_LOCAL_TEXT_TOOL_ARGUMENTS_LENGTH = 8_000;
const LOCAL_FINAL_ANSWER_OPEN = "<butler_final_answer>";
const LOCAL_FINAL_ANSWER_CLOSE = "</butler_final_answer>";
const LOCAL_TEXT_TOOL_CALL_OPEN_MARKERS = ["<|tool_call>", "<|tool_call|>", "<tool_call>"];
const LOCAL_TEXT_TOOL_CALL_CLOSE_MARKERS = ["<tool_call|>", "<|/tool_call|>", "</tool_call>"];

function localAssistantRawText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part?.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractLocalChatText(message: any): string {
  return sanitizeLocalAssistantText(localAssistantRawText(message).trim());
}

function extractLocalFinalEnvelopeText(message: any): string {
  const raw = localAssistantRawText(message).trim().replace(/\r\n?/gu, "\n");
  if (!raw) return "";
  const envelope = localFinalAnswerEnvelope(raw);
  if (envelope === null) return "";
  return sanitizeLocalAssistantText(envelope);
}

export function sanitizeLocalAssistantText(raw: string): string {
  let text = raw.replace(/\r\n?/gu, "\n");
  const finalEnvelope = localFinalAnswerEnvelope(text);
  if (finalEnvelope !== null) {
    text = finalEnvelope;
  }
  const protocolScanText = maskFencedCodeBlocks(text);
  const hasReasoningSignal = hasLocalReasoningProtocolSignal(protocolScanText);
  const finalStart = lastVisibleFinalMarkerEnd(protocolScanText, hasReasoningSignal);
  if (finalStart !== null) {
    text = text.slice(finalStart);
  }
  const fencedBlocks: string[] = [];
  text = preserveFencedCodeBlocks(text, fencedBlocks);
  text = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/giu, "");
  text = text.replace(/<think\b[^>]*>[\s\S]*$/iu, "");
  text = stripLocalTextToolCallBlocks(text);
  text = text.replace(/<\|[^>]*\|>/gu, "");
  text = text.replace(/<\/?s>/giu, "");
  text = text.replace(/<\/?(?:channel|message|start|end|analysis|final)\|[^>]*>/giu, "");
  if (hasReasoningSignal) {
    text = text.replace(/^\s*(?:analysis|reasoning)\s*:\s*$/gimu, "");
  }
  text = restoreFencedCodeBlocks(text, fencedBlocks);
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/gu, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function localFinalAnswerEnvelope(text: string): string | null {
  const lower = text.toLowerCase();
  const open = lower.lastIndexOf(LOCAL_FINAL_ANSWER_OPEN);
  if (open < 0) return null;
  const bodyStart = open + LOCAL_FINAL_ANSWER_OPEN.length;
  const close = lower.indexOf(LOCAL_FINAL_ANSWER_CLOSE, bodyStart);
  if (close < 0) {
    const openEnded = text.slice(bodyStart).trim();
    return openEnded || null;
  }
  const body = text.slice(bodyStart, close).trim();
  return body || null;
}

function stripLocalTextToolCallBlocks(text: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < text.length) {
    const open = findFirstLocalTextToolCallMarker(text, LOCAL_TEXT_TOOL_CALL_OPEN_MARKERS, cursor);
    if (!open) return output + text.slice(cursor);
    output += text.slice(cursor, open.index);
    const bodyStart = open.index + open.marker.length;
    const close = findFirstLocalTextToolCallMarker(text, LOCAL_TEXT_TOOL_CALL_CLOSE_MARKERS, bodyStart);
    if (!close) return output;
    cursor = close.index + close.marker.length;
  }
  return output;
}

function hasLocalReasoningProtocolSignal(text: string): boolean {
  return /<think\b|<\|channel\|analysis\|>|<channel\|analysis>|(?:^|\n)\s*(?:analysis|reasoning)\s*:/iu
    .test(text);
}

function maskFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, (block) => " ".repeat(block.length));
}

function preserveFencedCodeBlocks(text: string, fencedBlocks: string[]): string {
  return text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, (block) => {
    const index = fencedBlocks.push(block) - 1;
    return `\uE000${index}\uE001`;
  });
}

function restoreFencedCodeBlocks(text: string, fencedBlocks: string[]): string {
  return text.replace(/\uE000(\d+)\uE001/gu, (_token, index: string) => {
    return fencedBlocks[Number(index)] ?? "";
  });
}

function escapeRegExpText(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function standaloneLocalFunctionCallNames(text: string, allowedNames: Set<string>): string[] {
  if (!text.trim() || allowedNames.size === 0 || text.length > MAX_LOCAL_TEXT_TOOL_SCAN_LENGTH) return [];
  const scanText = maskFencedCodeBlocks(text);
  const matches = new Set<string>();
  for (const name of allowedNames) {
    if (!name) continue;
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExpText(name)}\\s*\\(`, "u");
    if (pattern.test(scanText)) matches.add(name);
  }
  return [...matches];
}

function localToolsForRequiredRepair(
  tools: FunctionToolDefinition[],
  requiredNames: Set<string> | null,
): FunctionToolDefinition[] {
  if (!requiredNames || requiredNames.size === 0) return tools;
  const narrowed = tools.filter((tool) => requiredNames.has(tool.name));
  return narrowed.length > 0 ? narrowed : tools;
}

function localFunctionToolContractRepairPrompt(): string {
  return [
    "## Local Tool Call Contract Repair",
    "Your previous response wrote a registered tool call as visible text instead of using the structured tool-call channel.",
    "That text has not been executed and must not be treated as a tool result.",
    "Continue the original user request now. If a tool is needed, choose the appropriate tool from the provided catalog and call it through the API structured `message.tool_calls` channel.",
    "Do not write raw function-call syntax, Markdown code, JSON tool calls, or process notes as a substitute for a tool call.",
    "You must use the structured tool-call channel on this repair turn. Do not answer directly unless no tool is available in the provided catalog.",
  ].join("\n");
}

function lastVisibleFinalMarkerEnd(text: string, allowTextualFinalMarker: boolean): number | null {
  const patterns = [
    /<\|channel\|final\|>/giu,
    /<channel\|final>/giu,
  ];
  if (allowTextualFinalMarker) {
    patterns.push(
      /(?:^|\n)\s*final\s*:/giu,
      /(?:^|\n)\s*assistant_final\s*:/giu,
    );
  }
  let latestEnd: number | null = null;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const end = match.index + match[0].length;
      if (latestEnd === null || end > latestEnd) {
        latestEnd = end;
      }
    }
  }
  return latestEnd;
}

function normalizeLocalTextToolName(rawName: string, allowedNames: Set<string>): string | null {
  const trimmed = rawName.trim();
  if (!trimmed) return null;
  const segments = trimmed.split(":").map((segment) => segment.trim()).filter(Boolean);
  const candidates = [
    trimmed,
    segments.length > 0 ? segments[segments.length - 1] : "",
  ].filter(Boolean);
  return candidates.find((candidate) => allowedNames.has(candidate)) ?? null;
}

function parseJsonObjectOrNull(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseLocalJsonishObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_LOCAL_TEXT_TOOL_ARGUMENTS_LENGTH) return null;
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const strict = parseJsonObjectOrNull(trimmed);
  if (strict) return strict;
  const normalized = trimmed
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:/gu, "$1\"$2\":")
    .replace(/,\s*([}\]])/gu, "$1");
  return parseJsonObjectOrNull(normalized);
}

function localTextToolArguments(raw: string): {
  parsed: Record<string, unknown>;
  raw: string;
} | null {
  const trimmed = raw.trim();
  if (!trimmed) return { parsed: {}, raw: "{}" };
  const argsStart = trimmed.indexOf("{");
  const argsEnd = trimmed.lastIndexOf("}");
  if (argsStart < 0 || argsEnd < argsStart) return null;
  const objectText = trimmed.slice(argsStart, argsEnd + 1);
  const parsed = parseLocalJsonishObject(objectText);
  if (!parsed) return null;
  return {
    parsed,
    raw: JSON.stringify(parsed),
  };
}

function parseLocalTextToolCallBody(
  body: string,
  allowedNames: Set<string>,
  index: number,
): LocalChatToolCall | null {
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > MAX_LOCAL_TEXT_TOOL_CALL_BODY_LENGTH) return null;

  const callMatch = trimmed.match(/^call\s*:\s*([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)*)\s*([\s\S]*)$/iu);
  if (callMatch) {
    const name = normalizeLocalTextToolName(callMatch[1] ?? "", allowedNames);
    if (!name) return null;
    const args = localTextToolArguments(callMatch[2] ?? "");
    if (!args) return null;
    return {
      id: `local_text_call_${index}`,
      type: "function",
      function: {
        name,
        arguments: args.raw,
      },
    };
  }

  const parsed = parseLocalJsonishObject(trimmed);
  if (!parsed) return null;
  const functionRecord = parsed.function && typeof parsed.function === "object" && !Array.isArray(parsed.function)
    ? parsed.function as Record<string, unknown>
    : null;
  const rawName = [
    parsed.name,
    parsed.tool_name,
    parsed.tool,
    parsed.function,
    functionRecord?.name,
  ].find((value): value is string => typeof value === "string");
  if (!rawName) return null;
  const name = normalizeLocalTextToolName(rawName, allowedNames);
  if (!name) return null;
  const rawArguments = parsed.arguments ?? parsed.args ?? parsed.parameters ??
    functionRecord?.arguments ?? functionRecord?.args ?? functionRecord?.parameters ?? {};
  const args = localToolArguments(rawArguments);
  return {
    id: `local_text_call_${index}`,
    type: "function",
    function: {
      name,
      arguments: args.raw,
    },
  };
}

function findFirstLocalTextToolCallMarker(
  text: string,
  markers: string[],
  start: number,
): { index: number; marker: string } | null {
  let best: { index: number; marker: string } | null = null;
  for (const marker of markers) {
    const index = text.indexOf(marker, start);
    if (index < 0) continue;
    if (!best || index < best.index) {
      best = { index, marker };
    }
  }
  return best;
}

function extractLocalTextToolCallBodies(text: string): string[] {
  if (text.length > MAX_LOCAL_TEXT_TOOL_SCAN_LENGTH) return [];
  const bodies: string[] = [];
  let cursor = 0;
  while (cursor < text.length && bodies.length < MAX_LOCAL_TEXT_TOOL_CALLS) {
    const open = findFirstLocalTextToolCallMarker(text, LOCAL_TEXT_TOOL_CALL_OPEN_MARKERS, cursor);
    if (!open) break;
    const bodyStart = open.index + open.marker.length;
    const close = findFirstLocalTextToolCallMarker(text, LOCAL_TEXT_TOOL_CALL_CLOSE_MARKERS, bodyStart);
    if (!close) break;
    bodies.push(text.slice(bodyStart, close.index));
    cursor = close.index + close.marker.length;
  }
  return bodies;
}

function extractLocalTextToolCalls(text: string, allowedNames: Set<string>): LocalChatToolCall[] {
  const calls: LocalChatToolCall[] = [];
  for (const body of extractLocalTextToolCallBodies(text)) {
    const call = parseLocalTextToolCallBody(body, allowedNames, calls.length + 1);
    if (call) calls.push(call);
  }
  return calls;
}

function extractLocalToolCalls(message: any, allowedNames: Set<string>): LocalChatToolCall[] {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const structuredCalls = calls.flatMap((call: any): LocalChatToolCall[] => {
    const name = normalizeLocalTextToolName(
      typeof call?.function?.name === "string" ? call.function.name : "",
      allowedNames,
    );
    if (
      !call ||
      typeof call !== "object" ||
      typeof call.id !== "string" ||
      !call.function ||
      typeof call.function !== "object" ||
      !name
    ) {
      return [];
    }
    return [{
      ...call,
      function: {
        ...call.function,
        name,
      },
    }];
  });
  if (calls.length > 0) return structuredCalls;
  return extractLocalTextToolCalls(localAssistantRawText(message), allowedNames);
}

async function createLocalChatCompletion(
  config: LocalModelConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  const requestBody = {
    temperature: 0,
    ...(Number.isFinite(config.max_output_tokens) && Number(config.max_output_tokens) > 0
      ? { max_tokens: Math.trunc(Number(config.max_output_tokens)) }
      : {}),
    ...body,
  };
  const endpoint = safeEndpointLabel(localChatUrl(config));
  const model = typeof body.model === "string" ? body.model : config.model_id;
  let response: Response;
  try {
    response = await fetch(localChatUrl(config), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal,
    });
  } catch (error) {
    throw providerNetworkError({
      provider: "local",
      api: "chat_completions",
      endpoint,
      model,
      error,
    });
  }
  const raw = await response.text();
  let parsed: Record<string, any>;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  if (!response.ok) {
    const detail = parsed?.error?.message || raw || `status ${response.status}`;
    throw providerHttpError({
      provider: "local",
      api: "chat_completions",
      statusCode: response.status,
      detail,
      endpoint,
      model,
    });
  }
  return parsed;
}

function firstLocalAssistantMessage(response: Record<string, any>): Record<string, any> {
  const message = response.choices?.[0]?.message;
  return message && typeof message === "object" ? message : {};
}

function isLocalContextOverflowError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const causeMessage = error instanceof ModelProviderRequestError ? error.causeMessage : "";
  const text = [error.message, causeMessage].filter(Boolean).join("\n");
  return /(?:available context size|context (?:size|window|length)|maximum context|too many tokens|request \(\d+ tokens\) exceeds)/iu
    .test(text);
}

function localToolFallbackInstructions(instructions?: string): string {
  return [
    instructions?.trim(),
    "The local model server rejected the tool-enabled request because its context window is too small for the full Butler tool schema. Answer directly without calling tools. If a tool would be required for certainty, say what cannot be verified from the available context.",
  ].filter(Boolean).join("\n\n");
}

function localFunctionToolInstructions(instructions?: string): string {
  return [
    instructions?.trim(),
    "When a request depends on current, external, public, or user-environment state, choose and call the appropriate tool from the provided tool catalog before answering. Do not ask the user to name the tool.",
    "When a tool is needed, use only the structured tool-call channel provided by the API (`message.tool_calls`) or an explicit backend-native `<|tool_call>...<tool_call|>` marker. Do not write pseudo tool calls, raw function-call syntax, Markdown code, JSON tool calls, or process notes as a substitute for a tool call. If you cannot call a tool, answer directly and say what cannot be verified.",
    "For local config, manifest, script, or log inspection, prefer a focused command that returns only the requested fields. Do not dump a whole file when a case-insensitive search or structured extraction can answer the question.",
  ].filter(Boolean).join("\n\n");
}

function localCompactEvidenceTools(tools: FunctionToolDefinition[]): FunctionToolDefinition[] {
  const evidenceToolNames = new Set(["web_search", "web_read"]);
  return tools.filter((tool) => evidenceToolNames.has(tool.name));
}

const MIN_LOCAL_TOOL_RESULT_TOTAL_TOKENS = 800;
const MAX_LOCAL_TOOL_RESULT_TOTAL_TOKENS = 12_000;
const LOCAL_TOOL_RESULT_TOTAL_CONTEXT_RATIO = 0.15;
const MIN_LOCAL_TOOL_RESULT_AGGRESSIVE_TOTAL_TOKENS = 300;
const MAX_LOCAL_TOOL_RESULT_AGGRESSIVE_TOTAL_TOKENS = 4_000;
const LOCAL_TOOL_RESULT_AGGRESSIVE_TOTAL_CONTEXT_RATIO = 0.04;
const LOCAL_TOOL_RESULT_COMPACT_MARKER = "[...compacted local tool result for context budget...]";

function localToolResultTotalTokenBudget(config: LocalModelConfig, aggressive = false): number {
  const window = Number.isFinite(config.context_window_tokens)
    ? Math.max(0, Math.trunc(Number(config.context_window_tokens)))
    : 0;
  const ratio = aggressive
    ? LOCAL_TOOL_RESULT_AGGRESSIVE_TOTAL_CONTEXT_RATIO
    : LOCAL_TOOL_RESULT_TOTAL_CONTEXT_RATIO;
  const min = aggressive
    ? MIN_LOCAL_TOOL_RESULT_AGGRESSIVE_TOTAL_TOKENS
    : MIN_LOCAL_TOOL_RESULT_TOTAL_TOKENS;
  const max = aggressive
    ? MAX_LOCAL_TOOL_RESULT_AGGRESSIVE_TOTAL_TOKENS
    : MAX_LOCAL_TOOL_RESULT_TOTAL_TOKENS;
  const proportional = window > 0 ? Math.floor(window * ratio) : max;
  return Math.max(min, Math.min(max, proportional));
}

function compactLocalToolResultContent(input: {
  source: string;
  toolName: string;
  maxTokens: number;
  log: (line: string) => void;
  reason: string;
  ok?: boolean;
}): string {
  const rawTokens = estimateContextTokens(input.source);
  if (rawTokens <= input.maxTokens) return input.source;

  const previewTokens = Math.max(40, input.maxTokens - 160);
  const preview = trimTextToTokenBudgetBalanced(input.source, previewTokens);
  const compactPayload = {
    ok: input.ok ?? true,
    output: {
      butler_tool_result_compacted: true,
      tool_name: input.toolName,
      compaction_reason: input.reason,
      raw_estimated_tokens: rawTokens,
      compact_estimated_tokens: estimateContextTokens(preview),
      preview,
    },
  };
  const compact = JSON.stringify(compactPayload);
  input.log(
    `tool ${input.toolName} result compacted for local context: reason=${input.reason} raw_tokens=${rawTokens} compact_tokens=${estimateContextTokens(compact)}`,
  );
  return compact;
}

function trimTextToTokenBudgetBalanced(text: string, maxTokens: number): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (estimateContextTokens(trimmed) <= maxTokens) return trimmed;
  const marker = `\n${LOCAL_TOOL_RESULT_COMPACT_MARKER}\n`;
  const maxChars = Math.max(80, Math.trunc(maxTokens) * 4 - marker.length);
  const headChars = Math.max(20, Math.floor(maxChars * 0.55));
  const tailChars = Math.max(20, maxChars - headChars);
  return [
    trimmed.slice(0, headChars).trimEnd(),
    marker.trim(),
    trimmed.slice(Math.max(0, trimmed.length - tailChars)).trimStart(),
  ].filter(Boolean).join("\n");
}

function localToolResultMessageContent(input: {
  payload: Record<string, unknown>;
  toolName: string;
  config: LocalModelConfig;
  log: (line: string) => void;
}): string {
  return JSON.stringify(input.payload);
}

function existingLocalToolContentSource(content: unknown): {
  source: string;
  ok?: boolean;
} {
  const raw = typeof content === "string" ? content : JSON.stringify(content ?? "");
  try {
    const parsed = JSON.parse(raw) as Record<string, any>;
    const output = parsed?.output;
    if (
      output &&
      typeof output === "object" &&
      output.butler_tool_result_compacted === true &&
      typeof output.preview === "string"
    ) {
      return {
        source: output.preview,
        ok: parsed.ok === true,
      };
    }
    return {
      source: raw,
      ok: parsed?.ok === true,
    };
  } catch {
    return { source: raw };
  }
}

function rebudgetLocalToolMessages(input: {
  messages: LocalChatMessage[];
  config: LocalModelConfig;
  log: (line: string) => void;
  aggressive?: boolean;
}): boolean {
  const toolMessages = input.messages.filter((message) => message.role === "tool");
  if (toolMessages.length === 0) return false;

  const totalBudget = localToolResultTotalTokenBudget(input.config, input.aggressive === true);
  const perToolBudget = Math.max(1, Math.floor(totalBudget / toolMessages.length));
  let changed = false;
  for (const message of toolMessages) {
    const { source, ok } = existingLocalToolContentSource(message.content);
    if (estimateContextTokens(source) <= perToolBudget) continue;
    message.content = compactLocalToolResultContent({
      source,
      toolName: message.name ?? "tool",
      maxTokens: perToolBudget,
      log: input.log,
      reason: input.aggressive === true ? "final_synthesis_context_retry" : "cumulative_tool_result_budget",
      ok,
    });
    changed = true;
  }
  return changed;
}

function localToolEvidenceDigest(messages: LocalChatMessage[], config: LocalModelConfig): string {
  const toolMessages = messages.filter((message) => message.role === "tool");
  if (toolMessages.length === 0) return "";
  const totalBudget = localToolResultTotalTokenBudget(config, true);
  const perToolBudget = Math.max(1, Math.floor(totalBudget / toolMessages.length));
  return toolMessages.map((message, index) => {
    const { source } = existingLocalToolContentSource(message.content);
    const preview = trimTextToTokenBudgetBalanced(source, perToolBudget);
    return [
      `Tool evidence ${index + 1}${message.name ? ` (${message.name})` : ""}:`,
      preview,
    ].join("\n");
  }).join("\n\n");
}

async function runLocalCompactFinalAnswerText(input: {
  config: LocalModelConfig;
  options: FunctionToolPromptOptions;
  messages: LocalChatMessage[];
  log: (line: string) => void;
}): Promise<string> {
  const evidence = localToolEvidenceDigest(input.messages, input.config);
  if (!evidence) throw new Error("Local model API request exceeded context window after tool execution");
  input.log("local model final synthesis exceeded context window after retry; using compact evidence-only final synthesis");
  const response = await createLocalChatCompletion(input.config, {
    model: input.config.model_id,
    messages: [
      {
        role: "system",
        content: [
          "You are Butler final answer synthesis.",
          "Use only the user task and compact tool evidence below.",
          "Do not expose hidden reasoning, tool logs, raw JSON, or process notes.",
          "Return exactly one `<butler_final_answer>...</butler_final_answer>` block.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "User task:",
          input.options.prompt,
          "",
          "Compact tool evidence:",
          evidence,
          "",
          finalNoToolInstructions(),
        ].join("\n"),
      },
    ],
    ...localReasoningRequestParams(input.config),
    stream: false,
  }, input.options.signal);
  const text = extractLocalFinalEnvelopeText(firstLocalAssistantMessage(response));
  if (!text) {
    throw providerEmptyResponseError({
      provider: "local",
      api: "chat_completions",
      endpoint: safeEndpointLabel(localChatUrl(input.config)),
      model: input.config.model_id,
      local: true,
    });
  }
  return text;
}

async function runLocalPromptText(options: PromptOptions): Promise<string> {
  const config = resolveLocalModelConfig(options.model);
  const messages: LocalChatMessage[] = [];
  if (options.instructions?.trim()) {
    messages.push({ role: "system", content: options.instructions.trim() });
  }
  messages.push({ role: "user", content: localUserContentWithAttachments(options.prompt, options.attachments) });
  const response = await createLocalChatCompletion(config, {
    model: config.model_id,
    messages,
    ...localReasoningRequestParams(config),
    stream: false,
  }, options.signal);
  const text = extractLocalChatText(firstLocalAssistantMessage(response));
  if (!text) {
    throw providerEmptyResponseError({
      provider: "local",
      api: "chat_completions",
      endpoint: safeEndpointLabel(localChatUrl(config)),
      model: config.model_id,
      local: true,
    });
  }
  return text;
}

async function runLocalFunctionToolPromptText(options: FunctionToolPromptOptions): Promise<string> {
  const config = resolveLocalModelConfig(options.model);
  const log = options.log ?? (() => {});
  const maxRounds = modelIterationLimitWithinUsageBudget(
    options.maxToolRounds ?? 8,
    options.usageAttribution,
  );
  const messages: LocalChatMessage[] = [{ role: "system", content: localFunctionToolInstructions(options.instructions) }];
  messages.push({ role: "user", content: localUserContentWithAttachments(options.prompt, options.attachments) });
  let executedToolCalls = 0;
  let toolContractRepairAttempted = false;
  let requiredToolRepairNames: Set<string> | null = null;

  for (let round = 0; round < maxRounds; round += 1) {
    const activeTools = activeFunctionTools(options);
    const allowedNames = new Set(activeTools.map((tool) => tool.name));
    let response;
    try {
      const requestTools = localToolsForRequiredRepair(activeTools, requiredToolRepairNames);
      response = await createLocalChatCompletion(config, {
        model: config.model_id,
        messages,
        tools: localChatTools(requestTools),
        tool_choice: requiredToolRepairNames ? "required" : "auto",
        ...localReasoningRequestParams(config),
        stream: false,
      }, options.signal);
    } catch (error) {
      if (!isLocalContextOverflowError(error)) throw error;
      if (executedToolCalls > 0) {
        log("local model tool prompt exceeded context window after tool results; synthesizing from compacted tool evidence without more tools");
        throwIfAborted(options.signal);
        break;
      }
      const compactTools = localCompactEvidenceTools(activeTools);
      if (compactTools.length > 0 && compactTools.length < activeTools.length) {
        log("local model tool prompt exceeded context window; retrying with compact evidence tool schemas");
        throwIfAborted(options.signal);
        return await runLocalFunctionToolPromptText({
          ...withoutDynamicTools(options),
          tools: compactTools,
        });
      }
      log("local model tool prompt exceeded context window; retrying without tool schemas");
      throwIfAborted(options.signal);
      return await runLocalPromptText({
        prompt: options.prompt,
        model: options.model,
        instructions: localToolFallbackInstructions(options.instructions),
        signal: options.signal,
        attachments: options.attachments,
      });
    }
    if (executedToolCalls > 0) {
      rebudgetLocalToolMessages({ messages, config, log });
    }
    const assistant = firstLocalAssistantMessage(response);
    const text = extractLocalChatText(assistant);
    const toolCalls = extractLocalToolCalls(assistant, allowedNames);
    if (toolCalls.length === 0) {
      if (executedToolCalls > 0) {
        log(text
          ? "local model returned post-tool draft; requesting final no-tool synthesis"
          : "local model returned no visible post-tool answer; requesting final no-tool synthesis");
        break;
      }
      if (!text) {
        throw providerEmptyResponseError({
          provider: "local",
          api: "chat_completions",
          endpoint: safeEndpointLabel(localChatUrl(config)),
          model: config.model_id,
          local: true,
        });
      }
      const standaloneToolNames = standaloneLocalFunctionCallNames(text, allowedNames);
      if (standaloneToolNames.length > 0) {
        if (!toolContractRepairAttempted) {
          toolContractRepairAttempted = true;
          requiredToolRepairNames = new Set(standaloneToolNames);
          log("local model wrote a tool call as visible text; requesting required structured tool-call repair");
          messages.push({ role: "user", content: localFunctionToolContractRepairPrompt() });
          continue;
        }
        if (!requiredToolRepairNames) {
          requiredToolRepairNames = new Set(standaloneToolNames);
          log("local model repeated visible tool-call text; forcing required structured tool-call repair");
          messages.push({ role: "user", content: localFunctionToolContractRepairPrompt() });
          continue;
        }
        log("local model repeated visible tool-call text after required repair; failing closed without displaying pseudo-call");
        throw new Error("Local model failed to use the structured tool-call channel after required repair");
      }
      return text;
    }

    requiredToolRepairNames = null;
    writeWorkerTrace((options as { taskDir?: string }).taskDir, "provider.assistant.tool_calls", {
      provider: "local",
      text_chars: text.length,
      tool_count: toolCalls.length,
      tool_names: toolCalls.map((call) => call.function.name),
      executed_tool_calls: executedToolCalls,
    });
    await options.onAssistantTextBeforeTools?.({
      text,
      toolCalls: toolCalls.map((call) => {
        const args = localToolArguments(call.function.arguments);
        return {
          name: call.function.name,
          args: args.parsed,
        };
      }),
    });

    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const args = localToolArguments(call.function.arguments);
      log(`tool ${call.function.name}: ${args.raw}`);
      writeWorkerTrace((options as { taskDir?: string }).taskDir, "provider.tool.start", {
        provider: "local",
        name: call.function.name,
        args_preview: compactTraceValue(args.parsed),
        raw_args_chars: args.raw.length,
      });
      let payload: Record<string, unknown>;
      try {
        const result = await options.executeTool({
          name: call.function.name,
          args: args.parsed,
          rawArguments: args.raw,
        });
        payload = { ok: true, output: result };
        writeWorkerTrace((options as { taskDir?: string }).taskDir, "provider.tool.finish", {
          provider: "local",
          name: call.function.name,
          ok: true,
          output_preview: compactTraceValue(result),
        });
        executedToolCalls += 1;
      } catch (error) {
        payload = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
        writeWorkerTrace((options as { taskDir?: string }).taskDir, "provider.tool.finish", {
          provider: "local",
          name: call.function.name,
          ok: false,
          error: compactTraceValue(payload.error),
        });
        executedToolCalls += 1;
      }
      const finalText = payload.ok
        ? await options.finalTextFromToolResult?.({
            name: call.function.name,
            args: args.parsed,
            output: payload.output,
          })
        : null;
      if (finalText?.trim()) return finalText.trim();
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: localToolResultMessageContent({
          payload,
          toolName: call.function.name,
          config,
          log,
        }),
      });
    }
  }

  messages.push({
    role: "user",
    content: finalNoToolInstructions(),
  });
  let response;
  try {
    response = await createLocalChatCompletion(config, {
      model: config.model_id,
      messages,
      ...localReasoningRequestParams(config),
      stream: false,
    }, options.signal);
  } catch (error) {
    if (!isLocalContextOverflowError(error)) throw error;
    const compacted = rebudgetLocalToolMessages({ messages, config, log, aggressive: true });
    if (!compacted) throw error;
    log("local model final synthesis exceeded context window; retrying with tighter compacted tool evidence");
    try {
      response = await createLocalChatCompletion(config, {
        model: config.model_id,
        messages,
        ...localReasoningRequestParams(config),
        stream: false,
      }, options.signal);
    } catch (retryError) {
      if (!isLocalContextOverflowError(retryError)) throw retryError;
      return await runLocalCompactFinalAnswerText({ config, options, messages, log });
    }
  }
  let text = extractLocalFinalEnvelopeText(firstLocalAssistantMessage(response));
  if (!text) {
    messages.push({
      role: "user",
      content: finalEnvelopeRetryInstructions(),
    });
    try {
      response = await createLocalChatCompletion(config, {
        model: config.model_id,
        messages,
        ...localReasoningRequestParams(config),
        stream: false,
      }, options.signal);
    } catch (error) {
      if (!isLocalContextOverflowError(error)) throw error;
      const compacted = rebudgetLocalToolMessages({ messages, config, log, aggressive: true });
      if (!compacted) throw error;
      log("local model final envelope retry exceeded context window; retrying with tighter compacted tool evidence");
      try {
        response = await createLocalChatCompletion(config, {
          model: config.model_id,
          messages,
          ...localReasoningRequestParams(config),
          stream: false,
        }, options.signal);
      } catch (retryError) {
        if (!isLocalContextOverflowError(retryError)) throw retryError;
        return await runLocalCompactFinalAnswerText({ config, options, messages, log });
      }
    }
    text = extractLocalFinalEnvelopeText(firstLocalAssistantMessage(response));
  }
  if (!text) {
    throw providerEmptyResponseError({
      provider: "local",
      api: "chat_completions",
      endpoint: safeEndpointLabel(localChatUrl(config)),
      model: config.model_id,
      local: true,
    });
  }
  return text;
}

type HostedOpenAICompatibleProviderId = "xai" | "qwen" | "kimi" | "zai";

interface HostedChatToolCall {
  id: string;
  type?: "function";
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

interface HostedChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: HostedChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

function promptTextForHosted(options: Pick<PromptOptions, "prompt" | "attachments">): string {
  return promptWithAttachmentContext(options.prompt, options.attachments);
}

function isHostedOpenAICompatibleProvider(
  providerId: HostedModelProviderId,
): providerId is HostedOpenAICompatibleProviderId {
  return providerId === "xai" || providerId === "qwen" || providerId === "kimi" || providerId === "zai";
}

function hostedProviderApiBase(config: HostedRuntimeConfig): string {
  if (config.apiBaseUrl) return config.apiBaseUrl.replace(/\/+$/u, "");
  const envKey = `BUTLER_${config.providerId.toUpperCase()}_BASE_URL`;
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/u, "");
  const defaultBaseUrl = defaultHostedProviderApiBaseUrl(config.providerId);
  if (defaultBaseUrl) return defaultBaseUrl;
  if (config.providerId === "anthropic") return "https://api.anthropic.com/v1";
  if (config.providerId === "google") return "https://generativelanguage.googleapis.com/v1beta";
  return "https://api.openai.com/v1";
}

function hostedChatCompletionsUrl(config: HostedRuntimeConfig): string {
  const base = hostedProviderApiBase(config);
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function anthropicMessagesUrl(config: HostedRuntimeConfig): string {
  const base = hostedProviderApiBase(config);
  return base.endsWith("/messages") ? base : `${base}/messages`;
}

function geminiGenerateContentUrl(config: HostedRuntimeConfig): string {
  const base = hostedProviderApiBase(config);
  if (base.includes(":generateContent")) return base;
  return `${base}/models/${encodeURIComponent(config.modelId)}:generateContent`;
}

function hostedAuthHeader(config: HostedRuntimeConfig): string {
  if (!config.apiKey) throw new Error(`Provider API key credential is not registered for ${config.modelRef}`);
  return `Bearer ${config.apiKey}`;
}

function hostedProviderErrorLabel(config: HostedRuntimeConfig): string {
  return config.providerId;
}

function hostedChatTools(tools: FunctionToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function hostedChatText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return sanitizeResponseFinalAnswerText(content);
  if (!Array.isArray(content)) return "";
  return sanitizeResponseFinalAnswerText(
    content
      .map((part) => typeof part?.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n"),
  );
}

function extractHostedChatToolCalls(message: any, allowedNames: Set<string>): HostedChatToolCall[] {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return calls.flatMap((call: any): HostedChatToolCall[] => {
    const name = normalizeLocalTextToolName(
      typeof call?.function?.name === "string" ? call.function.name : "",
      allowedNames,
    );
    if (
      !call ||
      typeof call !== "object" ||
      typeof call.id !== "string" ||
      !call.function ||
      typeof call.function !== "object" ||
      !name
    ) {
      return [];
    }
    return [{
      id: call.id,
      type: "function",
      function: {
        name,
        arguments: call.function.arguments ?? "{}",
      },
    }];
  });
}

async function createHostedChatCompletion(
  config: HostedRuntimeConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  const endpoint = safeEndpointLabel(hostedChatCompletionsUrl(config));
  let response: Response;
  try {
    response = await fetch(hostedChatCompletionsUrl(config), {
      method: "POST",
      headers: {
        Authorization: hostedAuthHeader(config),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        temperature: 0,
        model: config.modelId,
        ...body,
      }),
      signal,
    });
  } catch (error) {
    throw providerNetworkError({
      provider: hostedProviderErrorLabel(config),
      api: "chat_completions",
      endpoint,
      model: config.modelId,
      error,
    });
  }
  const raw = await response.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {}
  if (!response.ok) {
    throw providerHttpError({
      provider: hostedProviderErrorLabel(config),
      api: "chat_completions",
      statusCode: response.status,
      detail: parsed?.error?.message || raw || `status ${response.status}`,
      endpoint,
      model: config.modelId,
    });
  }
  return parsed;
}

function firstHostedChatMessage(response: Record<string, any>): Record<string, any> {
  const message = response.choices?.[0]?.message;
  return message && typeof message === "object" ? message : {};
}

async function runHostedOpenAICompatiblePromptText(
  config: HostedRuntimeConfig,
  options: PromptOptions,
): Promise<string> {
  const messages: HostedChatMessage[] = [];
  if (options.instructions?.trim()) {
    messages.push({ role: "system", content: options.instructions.trim() });
  }
  messages.push({ role: "user", content: promptTextForHosted(options) });
  const response = await createHostedChatCompletion(config, {
    messages,
    stream: false,
  }, options.signal);
  const text = hostedChatText(firstHostedChatMessage(response));
  if (!text) {
    throw providerEmptyResponseError({
      provider: hostedProviderErrorLabel(config),
      api: "chat_completions",
      endpoint: safeEndpointLabel(hostedChatCompletionsUrl(config)),
      model: config.modelId,
    });
  }
  return text;
}

async function runHostedOpenAICompatibleFunctionToolPromptText(
  config: HostedRuntimeConfig,
  options: FunctionToolPromptOptions,
): Promise<string> {
  const log = options.log ?? (() => {});
  const maxRounds = modelIterationLimitWithinUsageBudget(
    options.maxToolRounds ?? 8,
    options.usageAttribution,
  );
  const messages: HostedChatMessage[] = [];
  if (options.instructions?.trim()) {
    messages.push({ role: "system", content: options.instructions.trim() });
  }
  messages.push({ role: "user", content: promptTextForHosted(options) });

  for (let round = 0; round < maxRounds; round += 1) {
    const activeTools = activeFunctionTools(options);
    const allowedNames = new Set(activeTools.map((tool) => tool.name));
    const response = await createHostedChatCompletion(config, {
      messages,
      tools: hostedChatTools(activeTools),
      tool_choice: "auto",
      stream: false,
    }, options.signal);
    const assistant = firstHostedChatMessage(response);
    const text = hostedChatText(assistant);
    const toolCalls = extractHostedChatToolCalls(assistant, allowedNames);
    if (toolCalls.length === 0) {
      if (!text) {
        throw providerEmptyResponseError({
          provider: hostedProviderErrorLabel(config),
          api: "chat_completions",
          endpoint: safeEndpointLabel(hostedChatCompletionsUrl(config)),
          model: config.modelId,
        });
      }
      return text;
    }
    await options.onAssistantTextBeforeTools?.({
      text,
      toolCalls: toolCalls.map((call) => {
        const args = localToolArguments(call.function.arguments);
        return {
          name: call.function.name,
          args: args.parsed,
        };
      }),
    });
    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls,
    });
    for (const call of toolCalls) {
      const args = localToolArguments(call.function.arguments);
      log(`tool ${call.function.name}: ${args.raw}`);
      let payload: Record<string, unknown>;
      try {
        payload = {
          ok: true,
          output: await options.executeTool({
            name: call.function.name,
            args: args.parsed,
            rawArguments: args.raw,
          }),
        };
      } catch (error) {
        payload = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const finalText = payload.ok
        ? await options.finalTextFromToolResult?.({
            name: call.function.name,
            args: args.parsed,
            output: payload.output,
          })
        : null;
      if (finalText?.trim()) return finalText.trim();
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(payload),
      });
    }
  }

  messages.push({ role: "user", content: finalNoToolInstructions(options.instructions) });
  const response = await createHostedChatCompletion(config, {
    messages,
    stream: false,
  }, options.signal);
  const text = hostedChatText(firstHostedChatMessage(response));
  if (!text) {
    throw providerEmptyResponseError({
      provider: hostedProviderErrorLabel(config),
      api: "chat_completions",
      endpoint: safeEndpointLabel(hostedChatCompletionsUrl(config)),
      model: config.modelId,
    });
  }
  return text;
}

async function createAnthropicMessage(
  config: HostedRuntimeConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  const endpoint = safeEndpointLabel(anthropicMessagesUrl(config));
  let response: Response;
  try {
    response = await fetch(anthropicMessagesUrl(config), {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey ?? "",
        "anthropic-version": process.env.BUTLER_ANTHROPIC_VERSION?.trim() || "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.modelId,
        max_tokens: 4096,
        ...body,
      }),
      signal,
    });
  } catch (error) {
    throw providerNetworkError({
      provider: "anthropic",
      api: "messages",
      endpoint,
      model: config.modelId,
      error,
    });
  }
  const raw = await response.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {}
  if (!response.ok) {
    throw providerHttpError({
      provider: "anthropic",
      api: "messages",
      statusCode: response.status,
      detail: parsed?.error?.message || raw || `status ${response.status}`,
      endpoint,
      model: config.modelId,
    });
  }
  return parsed;
}

function anthropicText(response: Record<string, any>): string {
  return sanitizeResponseFinalAnswerText(
    (Array.isArray(response.content) ? response.content : [])
      .map((part: any) => part?.type === "text" && typeof part.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n"),
  );
}

function anthropicTools(tools: FunctionToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

async function runAnthropicPromptText(
  config: HostedRuntimeConfig,
  options: PromptOptions,
): Promise<string> {
  const response = await createAnthropicMessage(config, {
    ...(options.instructions?.trim() ? { system: options.instructions.trim() } : {}),
    messages: [{ role: "user", content: promptTextForHosted(options) }],
  }, options.signal);
  const text = anthropicText(response);
  if (!text) {
    throw providerEmptyResponseError({
      provider: "anthropic",
      api: "messages",
      endpoint: safeEndpointLabel(anthropicMessagesUrl(config)),
      model: config.modelId,
    });
  }
  return text;
}

async function runAnthropicFunctionToolPromptText(
  config: HostedRuntimeConfig,
  options: FunctionToolPromptOptions,
): Promise<string> {
  const log = options.log ?? (() => {});
  const allowedNames = new Set(options.tools.map((tool) => tool.name));
  const maxRounds = modelIterationLimitWithinUsageBudget(
    options.maxToolRounds ?? 8,
    options.usageAttribution,
  );
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: promptTextForHosted(options) },
  ];
  for (let round = 0; round < maxRounds; round += 1) {
    const response = await createAnthropicMessage(config, {
      system: localFunctionToolInstructions(options.instructions),
      messages,
      tools: anthropicTools(options.tools),
    }, options.signal);
    const content = Array.isArray(response.content) ? response.content : [];
    const text = anthropicText(response);
    const toolUses = content.flatMap((part: any) => {
      const name = normalizeLocalTextToolName(typeof part?.name === "string" ? part.name : "", allowedNames);
      if (part?.type !== "tool_use" || typeof part.id !== "string" || !name) return [];
      return [{ id: part.id as string, name, input: localToolArguments(part.input).parsed }];
    });
    if (toolUses.length === 0) {
      if (text) return text;
      throw providerEmptyResponseError({
        provider: "anthropic",
        api: "messages",
        endpoint: safeEndpointLabel(anthropicMessagesUrl(config)),
        model: config.modelId,
      });
    }
    await options.onAssistantTextBeforeTools?.({
      text,
      toolCalls: toolUses.map((call) => ({ name: call.name, args: call.input })),
    });
    messages.push({ role: "assistant", content });
    for (const call of toolUses) {
      const rawArguments = JSON.stringify(call.input);
      log(`tool ${call.name}: ${rawArguments}`);
      let payload: Record<string, unknown>;
      try {
        payload = {
          ok: true,
          output: await options.executeTool({
            name: call.name,
            args: call.input,
            rawArguments,
          }),
        };
      } catch (error) {
        payload = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const finalText = payload.ok
        ? await options.finalTextFromToolResult?.({
            name: call.name,
            args: call.input,
            output: payload.output,
          })
        : null;
      if (finalText?.trim()) return finalText.trim();
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(payload),
        }],
      });
    }
  }
  messages.push({ role: "user", content: finalNoToolInstructions(options.instructions) });
  const response = await createAnthropicMessage(config, {
    system: finalNoToolInstructions(options.instructions),
    messages,
  }, options.signal);
  const text = anthropicText(response);
  if (!text) {
    throw providerEmptyResponseError({
      provider: "anthropic",
      api: "messages",
      endpoint: safeEndpointLabel(anthropicMessagesUrl(config)),
      model: config.modelId,
    });
  }
  return text;
}

async function createGeminiContent(
  config: HostedRuntimeConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  const endpoint = safeEndpointLabel(geminiGenerateContentUrl(config));
  let response: Response;
  try {
    response = await fetch(geminiGenerateContentUrl(config), {
      method: "POST",
      headers: {
        "x-goog-api-key": config.apiKey ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw providerNetworkError({
      provider: "google",
      api: "generate_content",
      endpoint,
      model: config.modelId,
      error,
    });
  }
  const raw = await response.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {}
  if (!response.ok) {
    throw providerHttpError({
      provider: "google",
      api: "generate_content",
      statusCode: response.status,
      detail: parsed?.error?.message || raw || `status ${response.status}`,
      endpoint,
      model: config.modelId,
    });
  }
  return parsed;
}

function geminiText(response: Record<string, any>): string {
  const parts = response.candidates?.[0]?.content?.parts;
  return sanitizeResponseFinalAnswerText(
    (Array.isArray(parts) ? parts : [])
      .map((part: any) => typeof part?.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n"),
  );
}

function geminiTools(tools: FunctionToolDefinition[]): Array<Record<string, unknown>> {
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  }];
}

async function runGeminiPromptText(
  config: HostedRuntimeConfig,
  options: PromptOptions,
): Promise<string> {
  const response = await createGeminiContent(config, {
    ...(options.instructions?.trim()
      ? { systemInstruction: { parts: [{ text: options.instructions.trim() }] } }
      : {}),
    contents: [{ role: "user", parts: [{ text: promptTextForHosted(options) }] }],
  }, options.signal);
  const text = geminiText(response);
  if (!text) {
    throw providerEmptyResponseError({
      provider: "google",
      api: "generate_content",
      endpoint: safeEndpointLabel(geminiGenerateContentUrl(config)),
      model: config.modelId,
    });
  }
  return text;
}

async function runGeminiFunctionToolPromptText(
  config: HostedRuntimeConfig,
  options: FunctionToolPromptOptions,
): Promise<string> {
  const log = options.log ?? (() => {});
  const allowedNames = new Set(options.tools.map((tool) => tool.name));
  const maxRounds = modelIterationLimitWithinUsageBudget(
    options.maxToolRounds ?? 8,
    options.usageAttribution,
  );
  const contents: Array<Record<string, unknown>> = [
    { role: "user", parts: [{ text: promptTextForHosted(options) }] },
  ];
  for (let round = 0; round < maxRounds; round += 1) {
    const response = await createGeminiContent(config, {
      systemInstruction: { parts: [{ text: localFunctionToolInstructions(options.instructions) }] },
      contents,
      tools: geminiTools(options.tools),
    }, options.signal);
    const parts = response.candidates?.[0]?.content?.parts;
    const responseParts = Array.isArray(parts) ? parts : [];
    const text = geminiText(response);
    const calls = responseParts.flatMap((part: any) => {
      const functionCall = part?.functionCall;
      const name = normalizeLocalTextToolName(
        typeof functionCall?.name === "string" ? functionCall.name : "",
        allowedNames,
      );
      if (!name) return [];
      const args = localToolArguments(functionCall.args ?? {});
      return [{ id: `gemini_call_${round}_${name}`, name, args: args.parsed, raw: args.raw }];
    });
    if (calls.length === 0) {
      if (text) return text;
      throw providerEmptyResponseError({
        provider: "google",
        api: "generate_content",
        endpoint: safeEndpointLabel(geminiGenerateContentUrl(config)),
        model: config.modelId,
      });
    }
    await options.onAssistantTextBeforeTools?.({
      text,
      toolCalls: calls.map((call) => ({ name: call.name, args: call.args })),
    });
    contents.push({ role: "model", parts: responseParts });
    for (const call of calls) {
      log(`tool ${call.name}: ${call.raw}`);
      let payload: Record<string, unknown>;
      try {
        payload = {
          ok: true,
          output: await options.executeTool({
            name: call.name,
            args: call.args,
            rawArguments: call.raw,
          }),
        };
      } catch (error) {
        payload = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const finalText = payload.ok
        ? await options.finalTextFromToolResult?.({
            name: call.name,
            args: call.args,
            output: payload.output,
          })
        : null;
      if (finalText?.trim()) return finalText.trim();
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: call.name,
            response: payload,
          },
        }],
      });
    }
  }
  contents.push({ role: "user", parts: [{ text: finalNoToolInstructions(options.instructions) }] });
  const response = await createGeminiContent(config, {
    systemInstruction: { parts: [{ text: localFunctionToolInstructions(options.instructions) }] },
    contents,
  }, options.signal);
  const text = geminiText(response);
  if (!text) {
    throw providerEmptyResponseError({
      provider: "google",
      api: "generate_content",
      endpoint: safeEndpointLabel(geminiGenerateContentUrl(config)),
      model: config.modelId,
    });
  }
  return text;
}

async function runHostedPromptText(
  config: HostedRuntimeConfig,
  options: PromptOptions,
): Promise<string> {
  if (config.providerId === "openai") {
    const resolution = resolveOpenAIModel(config.modelId, options.reasoningEffort);
    const model = await resolveDynamicOpenAIModel(resolution.model);
    const promptCache = resolveOpenAIPromptCacheConfig(options.cacheScope ?? "text-prompt");
    beforeAttributedModelRequest({
      attribution: options.usageAttribution,
      roundIndex: options.usageAttribution?.roundIndex ?? 0,
    });
    const response = await createOpenAIResponse({
      model,
      store: true,
      ...promptCache,
      instructions: options.instructions,
      reasoning: buildReasoningConfig(resolution),
      input: openAIInputWithAttachments(options.prompt, options.attachments),
    }, options.signal, await openAIAuthOverrideForHosted(config));
    afterAttributedModelResponse({
      attribution: options.usageAttribution,
      model,
      response,
      roundIndex: options.usageAttribution?.roundIndex ?? 0,
    });
    recordPromptCacheMetric(response, {
      model,
      scope: options.cacheScope ?? "text-prompt",
      promptCache,
      butlerData: options.butlerData,
      usageAttribution: {
        ...options.usageAttribution,
        reasoningEffort: resolution.reasoningEffort,
        roundIndex: options.usageAttribution?.roundIndex ?? 0,
      },
    });
    const text = extractResponseText(response);
    if (!text) {
      throw providerEmptyResponseError({
        provider: "openai",
        api: "responses",
        endpoint: safeEndpointLabel(getResponsesUrl()),
        model,
      });
    }
    return text;
  }
  if (config.providerId === "anthropic") return await runAnthropicPromptText(config, options);
  if (config.providerId === "google") return await runGeminiPromptText(config, options);
  if (isHostedOpenAICompatibleProvider(config.providerId)) {
    return await runHostedOpenAICompatiblePromptText(config, options);
  }
  throw new Error(`Unsupported hosted provider: ${config.providerId}`);
}

async function runHostedFunctionToolPromptText(
  config: HostedRuntimeConfig,
  options: FunctionToolPromptOptions,
): Promise<string> {
  if (config.providerId === "openai") {
    return await runOpenAIFunctionToolPromptText(options, await openAIAuthOverrideForHosted(config), config.modelId);
  }
  if (config.providerId === "anthropic") return await runAnthropicFunctionToolPromptText(config, options);
  if (config.providerId === "google") return await runGeminiFunctionToolPromptText(config, options);
  if (isHostedOpenAICompatibleProvider(config.providerId)) {
    return await runHostedOpenAICompatibleFunctionToolPromptText(config, options);
  }
  throw new Error(`Unsupported hosted provider: ${config.providerId}`);
}

async function executeShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}> {
  return await new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env: {
        ...process.env,
        PATH: augmentedPath(),
        BUTLER_HOME: getButlerHome(),
        BUTLER_DATA: getButlerData(),
        BUTLER_WORKER: "1",
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const settle = (result: { stdout: string; stderr: string; exit_code: number | null; timed_out: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      settle({
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
        exit_code: null,
        timed_out: timedOut,
      });
    });
    child.on("close", (code) => {
      settle({
        stdout,
        stderr,
        exit_code: timedOut ? null : (code ?? 0),
        timed_out: timedOut,
      });
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKillTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();
  });
}

export async function runPromptTextWithUsage(options: PromptOptions): Promise<PromptTextResult> {
  throwIfAborted(options.signal);
  if (isLocalModelRequest(options.model)) {
    return {
      text: await runLocalPromptText(options),
      model: options.model ?? "local",
      usage: null,
    };
  }
  const hostedConfig = resolveHostedRuntimeConfig(options.model);
  if (hostedConfig) {
    return {
      text: await runHostedPromptText(hostedConfig, options),
      model: hostedConfig.modelRef,
      usage: null,
    };
  }
  const resolution = resolveOpenAIModel(options.model, options.reasoningEffort);
  const model = await resolveDynamicOpenAIModel(resolution.model);
  const promptCache = resolveOpenAIPromptCacheConfig(options.cacheScope ?? "text-prompt");
  beforeAttributedModelRequest({
    attribution: options.usageAttribution,
    roundIndex: options.usageAttribution?.roundIndex ?? 0,
  });
  const response = await createOpenAIResponse({
    model,
    store: true,
    ...promptCache,
    instructions: options.instructions,
    reasoning: buildReasoningConfig(resolution),
    input: openAIInputWithAttachments(options.prompt, options.attachments),
  }, options.signal);
  afterAttributedModelResponse({
    attribution: options.usageAttribution,
    model,
    response,
    roundIndex: options.usageAttribution?.roundIndex ?? 0,
  });
  recordPromptCacheMetric(response, {
    model,
    scope: options.cacheScope ?? "text-prompt",
    promptCache,
    butlerData: options.butlerData,
    usageAttribution: {
      ...options.usageAttribution,
      reasoningEffort: resolution.reasoningEffort,
      roundIndex: options.usageAttribution?.roundIndex ?? 0,
    },
  });

  const text = extractResponseText(response);
  if (!text) {
    throw providerEmptyResponseError({
      provider: "openai",
      api: "responses",
      endpoint: safeEndpointLabel(getResponsesUrl()),
      model,
    });
  }
  const stats = extractPromptCacheStats(response);
  return {
    text,
    model,
    usage: stats
      ? {
          model,
          promptTokens: stats.promptTokens,
          cachedTokens: stats.cachedTokens,
          totalTokens: stats.totalTokens,
          outputTokens: stats.totalTokens === null || stats.promptTokens === null
            ? 0
            : Math.max(0, stats.totalTokens - stats.promptTokens),
        }
      : null,
  };
}

export async function runPromptText(options: PromptOptions): Promise<string> {
  return (await runPromptTextWithUsage(options)).text;
}

export async function runFunctionToolPromptText(options: FunctionToolPromptOptions): Promise<string> {
  throwIfAborted(options.signal);
  if (isLocalModelRequest(options.model)) {
    return await runLocalFunctionToolPromptText(options);
  }
  const hostedConfig = resolveHostedRuntimeConfig(options.model);
  if (hostedConfig) {
    return await runHostedFunctionToolPromptText(hostedConfig, options);
  }
  return await runOpenAIFunctionToolPromptText(options);
}

async function runOpenAIFunctionToolPromptText(
  options: FunctionToolPromptOptions,
  authOverride?: OpenAIAuthOverride,
  modelOverride?: string,
): Promise<string> {
  if (getButlerRuntime() !== "codex-api" && !authOverride) {
    throw new Error("runFunctionToolPromptText is only available when BUTLER_RUNTIME=codex-api");
  }
  const resolution = resolveOpenAIModel(modelOverride ?? options.model);
  const model = await resolveDynamicOpenAIModel(resolution.model);
  const reasoning = buildReasoningConfig(resolution);
  const log = options.log ?? (() => {});
  const promptCache = resolveOpenAIPromptCacheConfig(options.cacheScope ?? "function-tool-prompt");
  const maxRounds = modelIterationLimitWithinUsageBudget(
    options.maxToolRounds ?? 8,
    options.usageAttribution,
  );
  let previousResponseId: string | null = null;
  let sentToolMessages = 0;
  const initialPromptInput = openAIInputWithAttachments(options.prompt, options.attachments);
  const promptForAgentLoop = promptWithAttachmentContext(options.prompt, options.attachments);
  const codexStatelessInput = toCodexStatelessInput(initialPromptInput);
  let modelCallRound = 0;
  const agentLoopTools = activeFunctionTools(options).map(functionToolToAgentTool);

  const result = await runAgentLoop({
    messages: [{ role: "user", content: promptForAgentLoop }],
    tools: agentLoopTools,
    maxIterations: maxRounds,
    callModel: async ({ messages }) => {
      const activeTools = activeFunctionTools(options);
      const allowedNames = new Set(activeTools.map((tool) => tool.name));
      agentLoopTools.splice(0, agentLoopTools.length, ...activeTools.map(functionToolToAgentTool));
      const input = previousResponseId
        ? newToolMessages(messages, sentToolMessages)
        : { items: initialPromptInput, sentCount: sentToolMessages };
      sentToolMessages = input.sentCount;
      if (previousResponseId && Array.isArray(input.items)) {
        codexStatelessInput.push(...input.items);
      }

      beforeAttributedModelRequest({
        attribution: options.usageAttribution,
        roundIndex: modelCallRound,
      });
      const response = await createOpenAIResponse({
        model,
        store: true,
        ...promptCache,
        instructions: options.instructions,
        tools: activeTools,
        reasoning,
        ...(previousResponseId
          ? {
              previous_response_id: previousResponseId,
              input: input.items,
              __butler_codex_stateless_input: codexStatelessInput,
            }
          : {
              input: input.items,
              __butler_codex_stateless_input: codexStatelessInput,
            }),
      }, options.signal, authOverride);
      afterAttributedModelResponse({
        attribution: options.usageAttribution,
        model,
        response,
        roundIndex: modelCallRound,
      });
      previousResponseId = response.id;
      const functionCallItems = functionCallContinuationItems(response, allowedNames);
      if (functionCallItems.length > 0) {
        codexStatelessInput.push(...functionCallItems);
      }
      recordPromptCacheMetric(response, {
        model,
        scope: options.cacheScope ?? "function-tool-prompt",
        promptCache,
        butlerData: options.butlerData,
        usageAttribution: {
          ...options.usageAttribution,
          reasoningEffort: resolution.reasoningEffort,
          roundIndex: modelCallRound,
        },
      });
      modelCallRound += 1;
      logPromptCacheStats(response, log, promptCache);
      return responseToAgentModelResponse(response, allowedNames);
    },
    executeTool: async (call) => {
      log(`tool ${call.name}: ${JSON.stringify(call.arguments)}`);
      return await options.executeTool({
        name: call.name,
        args: call.arguments,
        rawArguments: JSON.stringify(call.arguments),
      });
    },
    finalTextFromToolResult: async ({ toolCall, toolResult }) =>
      await options.finalTextFromToolResult?.({
        name: toolCall.name,
        args: toolCall.arguments,
        output: toolResult.output,
      }),
    onAssistantTextBeforeTools: async ({ text, toolCalls }) => {
      await options.onAssistantTextBeforeTools?.({
        text,
        toolCalls: toolCalls.map((call) => ({
          name: call.name,
          args: call.arguments,
        })),
      });
    },
    onLoopLimit: async ({ messages }) => {
      if (!previousResponseId) return "";
      const pending = newToolMessages(messages, sentToolMessages);
      if (pending.items.length === 0) return "";
      sentToolMessages = pending.sentCount;
      codexStatelessInput.push(...pending.items);
      try {
        beforeAttributedModelRequest({
          attribution: options.usageAttribution,
          roundIndex: modelCallRound,
        });
        const response = await createOpenAIResponse({
          model,
          store: true,
          ...promptCache,
          instructions: finalNoToolInstructions(options.instructions),
          reasoning,
          previous_response_id: previousResponseId,
          input: pending.items,
          __butler_codex_stateless_input: codexStatelessInput,
        }, options.signal, authOverride);
        afterAttributedModelResponse({
          attribution: options.usageAttribution,
          model,
          response,
          roundIndex: modelCallRound,
        });
        previousResponseId = response.id;
        recordPromptCacheMetric(response, {
          model,
          scope: options.cacheScope ?? "function-tool-prompt",
          promptCache,
          butlerData: options.butlerData,
          usageAttribution: {
            ...options.usageAttribution,
            reasoningEffort: resolution.reasoningEffort,
            roundIndex: modelCallRound,
          },
        });
        modelCallRound += 1;
        logPromptCacheStats(response, log, promptCache);
        return extractResponseText(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`final no-tool synthesis failed; using safe fallback: ${message}`);
        return "";
      }
    },
  });

  if (!result.finalText.trim()) {
    throw new Error("Runtime finished without a text result");
  }
  return result.finalText;
}

export async function runShellTask(options: ShellTaskOptions): Promise<string> {
  if (getButlerRuntime() !== "codex-api") {
    throw new Error("runShellTask is only available when BUTLER_RUNTIME=codex-api");
  }
  const resolution = resolveWorkerShellOpenAIModel(options.model);
  const model = await resolveDynamicOpenAIModel(resolution.model);
  const reasoning = buildReasoningConfig(resolution);
  const log = options.log ?? (() => {});
  const promptCache = resolveOpenAIPromptCacheConfig(options.cacheScope ?? "tool-prompt");
  const codexStatelessInput = toCodexStatelessInput(options.prompt);
  const messageLanguage = options.messageLanguage ?? resolveRuntimeMessageLanguage();
  const shellTools = modelFacingFunctionTools([SHELL_TOOL]);

  await reportWorkerActivity(options.onActivity, {
    phase: "planning",
    statusLine: "Planning: choosing the worker step path.",
    currentTitle: messageLanguage === "ko" ? "워커 실행 경로를 정합니다." : "Choosing the worker step path.",
  });
  let response = await withWorkerActivityHeartbeat(
    options.onActivity,
    "planning",
    workerPlanningStatusLine,
    () => createOpenAIResponse({
      model,
      store: true,
      ...promptCache,
      instructions: options.instructions,
      tools: shellTools,
      reasoning,
      input: options.prompt,
      __butler_codex_stateless_input: codexStatelessInput,
    }),
  );
  const shellToolNames = new Set(["run_shell"]);
  const initialFunctionCallItems = functionCallContinuationItems(response, shellToolNames);
  if (initialFunctionCallItems.length > 0) {
    codexStatelessInput.push(...initialFunctionCallItems);
  }
  recordPromptCacheMetric(response, {
    model,
    scope: options.cacheScope ?? "tool-prompt",
    promptCache,
  });
  logPromptCacheStats(response, log, promptCache);

  const maxToolRounds = Math.max(1, Math.min(options.maxToolRounds ?? MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS));

  for (let round = 0; round < maxToolRounds; round++) {
    const calls = getFunctionCalls(response, new Set(["run_shell"]));
    if (calls.length === 0) {
      const text = extractResponseText(response);
      if (!text) throw new Error("Worker finished without a text result");
      await reportWorkerActivity(options.onActivity, {
        phase: "reporting",
        statusLine: "Reporting: composing the worker result.",
        currentTitle: workerReportingTitle(messageLanguage),
      });
      return text;
    }

    const toolOutputs: Array<Record<string, unknown>> = [];
    for (const call of calls) {
      const parsedArgs = parseToolArguments(call.arguments);

      const command = typeof parsedArgs.command === "string" ? parsedArgs.command.trim() : "";
      if (!command) {
        toolOutputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({
            stdout: "",
            stderr: "run_shell requires a non-empty command",
            exit_code: 64,
            timed_out: false,
          }),
        });
        continue;
      }

      await reportWorkerActivity(
        options.onActivity,
        workerActivityUpdateForShellCommand(command, call.call_id, messageLanguage),
      );
      const timeoutMs = clampTimeout(parsedArgs.timeout_ms);
      const justification =
        typeof parsedArgs.justification === "string" && parsedArgs.justification.trim()
          ? ` (${parsedArgs.justification.trim()})`
          : "";

      log(`run_shell${justification}: ${command}`);
      const result = await executeShellCommand(command, options.projectPath, timeoutMs);
      const budgetedResult = budgetToolOutput({
        result,
        command,
        cwd: options.projectPath,
        maxModelTokens: 1_200,
      });
      log(`run_shell result: exit=${result.exit_code ?? "null"} timed_out=${result.timed_out}`);
      if (result.stdout.trim()) log(`stdout:\n${truncateForLog(result.stdout.trim())}`);
      if (result.stderr.trim()) log(`stderr:\n${truncateForLog(result.stderr.trim())}`);
      if (budgetedResult.butler_tool_artifact) {
        log(`tool output compacted: artifact=${budgetedResult.butler_tool_artifact.id} raw_tokens=${budgetedResult.butler_tool_artifact.raw_tokens} compact_tokens=${budgetedResult.butler_tool_artifact.compact_tokens}`);
      }
      await reportWorkerActivity(options.onActivity, {
        phase: "consolidating",
        statusLine: workerEvidenceStatusLineForCommand(command, 0),
        currentTitle: workerEvidenceActivityTitle(command, messageLanguage),
        workBlock: summarizeWorkerShellWorkBlock(command, call.call_id, messageLanguage, "delivered"),
      });

      toolOutputs.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(budgetedResult),
      });
    }

    codexStatelessInput.push(...toolOutputs);
    if (round >= maxToolRounds - 1) {
      await reportWorkerActivity(options.onActivity, {
        phase: "reporting",
        statusLine: workerReportingStatusLine(0),
        currentTitle: workerReportingTitle(messageLanguage),
      });
      const finalResponse = await withWorkerActivityHeartbeat(
        options.onActivity,
        "reporting",
        workerReportingStatusLine,
        () => createOpenAIResponse({
          model,
          store: true,
          ...promptCache,
          instructions: finalNoToolInstructions(options.instructions),
          reasoning,
          previous_response_id: response.id,
          input: toolOutputs,
          __butler_codex_stateless_input: codexStatelessInput,
        }),
      );
      recordPromptCacheMetric(finalResponse, {
        model,
        scope: options.cacheScope ?? "tool-prompt",
        promptCache,
      });
      logPromptCacheStats(finalResponse, log, promptCache);
      const text = extractResponseText(finalResponse);
      if (!text) throw new Error("Worker reached tool budget and final synthesis returned no text result");
      return text;
    }

    const onlyCallArgs = calls.length === 1 ? parseToolArguments(calls[0]!.arguments) : {};
    const onlyCommand = typeof onlyCallArgs.command === "string" ? onlyCallArgs.command : "";
    const evidenceStatusLine = (elapsedMs: number) =>
      toolOutputs.length === 1 && onlyCommand
        ? workerEvidenceStatusLineForCommand(onlyCommand, elapsedMs)
        : workerEvidenceStatusLine(elapsedMs);
    response = await withWorkerActivityHeartbeat(
      options.onActivity,
      "consolidating",
      evidenceStatusLine,
      () => createOpenAIResponse({
        model,
        store: true,
        ...promptCache,
        instructions: options.instructions,
        tools: shellTools,
        reasoning,
        previous_response_id: response.id,
        input: toolOutputs,
        __butler_codex_stateless_input: codexStatelessInput,
      }),
    );
    const functionCallItems = functionCallContinuationItems(response, shellToolNames);
    if (functionCallItems.length > 0) {
      codexStatelessInput.push(...functionCallItems);
    }
    recordPromptCacheMetric(response, {
      model,
      scope: options.cacheScope ?? "tool-prompt",
      promptCache,
    });
    logPromptCacheStats(response, log, promptCache);
  }

  throw new Error(`Worker exceeded ${MAX_TOOL_ROUNDS} tool rounds without finishing`);
}

export async function runWorkerTask(options: WorkerOptions): Promise<string> {
  const taskId = basename(options.taskDir);
  const requestPath = join(options.taskDir, "request.md");
  const taskDesc = loadFileIfExists(requestPath);
  if (!taskDesc) {
    throw new Error(`Worker request not found at ${requestPath}`);
  }

  const prompt = `Task ID: ${taskId}
Project path: ${options.projectPath}

${buildWorkerMemoryContextInstruction()}

Task:
${taskDesc}`;

  writeWorkerTrace(options.taskDir, "worker.prompt.built", {
    prompt_chars: prompt.length,
    task_chars: taskDesc.length,
    has_memory_instruction: prompt.includes("memory"),
  });

  return await runShellTask({
    prompt,
    projectPath: options.projectPath,
    taskDir: options.taskDir,
    model: options.model,
    instructions: buildWorkerInstructions(),
    cacheScope: "worker",
    log: options.log,
    onActivity: options.onActivity,
    messageLanguage: resolveRuntimeMessageLanguage(),
    maxToolRounds: DEFAULT_WORKER_TOOL_ROUNDS,
  });
}
