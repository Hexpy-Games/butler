import type { AttachmentRef } from "../../test-support/harness/contracts.ts";
import type { OpenAIAuthMode } from "./openai/auth.ts";
import type { RuntimeMessageLanguage } from "../../agent/output/messages.ts";


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
  cumulativeRequestCount?: number;
  cumulativePromptTokens?: number;
  cumulativeCachedTokens?: number;
  cumulativeOutputTokens?: number;
  cumulativeTotalTokens?: number;
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


export interface PromptOptions {
  prompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  instructions?: string;
  responseFormat?: {
    type: "json_schema";
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
  cacheScope?: string;
  signal?: AbortSignal;
  attachments?: AttachmentRef[];
  butlerData?: string;
  usageAttribution?: PromptUsageAttribution;
  onProviderStreamEvent?: ProviderStreamProjectionHandler;
}


export interface WorkerOptions {
  taskDir: string;
  projectPath: string;
  model?: string;
  log?: (line: string) => void;
  onActivity?: WorkerActivityHandler;
}


export interface ShellTaskOptions {
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


export type WorkerActivityHandler = (update: WorkerActivityUpdate) => void | Promise<void>;


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

export type ProviderFinalCandidateReview =
  | { status: "accepted"; text?: string }
  | { status: "continue"; observation: string; requiredDeliverables?: string[] };


export interface FunctionToolPromptOptions {
  prompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  instructions?: string;
  cacheScope?: string;
  signal?: AbortSignal;
  attachments?: AttachmentRef[];
  butlerData?: string;
  usageAttribution?: PromptUsageAttribution;
  onProviderStreamEvent?: ProviderStreamProjectionHandler;
  tools: FunctionToolDefinition[];
  dynamicTools?: () => readonly FunctionToolDefinition[];
  maxToolRounds?: number;
  handoffAfterToolBatch?: boolean;
  toolChoice?: "auto" | "required";
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
  reviewFinalCandidate?: (input: {
    text: string;
    roundIndex: number;
  }) => Promise<ProviderFinalCandidateReview> | ProviderFinalCandidateReview;
}


export type ProviderStreamTextTarget = "opening_decision" | "public_note" | "final_candidate";


export type ProviderStreamProjectionChunk =
  | {
      type: "text_delta";
      streamId?: string;
      sequence?: number;
      textDelta: string;
      target?: ProviderStreamTextTarget;
      raw?: unknown;
    }
  | {
      type: "reasoning_delta";
      streamId?: string;
      sequence?: number;
      textDelta?: string;
      charCount?: number;
      raw?: unknown;
    }
  | {
      type: "tool_call_delta";
      streamId?: string;
      callIndex: number;
      sequence?: number;
      toolCallId?: string;
      toolName?: string;
      argumentsDelta?: string;
      argumentCharCount?: number;
      publicState?: "generating" | "ready";
      raw?: unknown;
    }
  | {
      type: "completed";
      streamId?: string;
      status: "completed" | "failed" | "aborted";
      raw?: unknown;
    };


export type ProviderStreamProjectionHandler = (
  chunk: ProviderStreamProjectionChunk,
) => void | Promise<void>;


export interface OpenAIAuthOverride {
  authorization: string;
  mode: OpenAIAuthMode;
}


export interface OpenAIResponse {
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


export interface CodexSseAccumulator {
  output: Array<Record<string, any>>;
  completed: Record<string, any> | null;
  fallbackText: string;
  sequence: number;
  fallbackStreamId: string;
  onProviderStreamEvent?: ProviderStreamProjectionHandler;
}
