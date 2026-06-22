import type { RuntimeTurnEventInput } from "../../agent/events/turn-events.ts";
export type { RuntimeTurnEventInput } from "../../agent/events/turn-events.ts";
import type {
  ArtifactRef,
  InboundEnvelope,
  ModelRef,
  OutboundAction,
  PromptCacheRetention,
  SessionRole,
} from "../../gateways/core/contracts.ts";
export type {
  ArtifactRef,
  AttachmentRef,
  DeliveryResult,
  InboundEnvelope,
  ModelRef,
  OutboundAction,
  PromptCacheRetention,
  SessionRole,
  TransportAdapter,
  TransportCapabilities,
} from "../../gateways/core/contracts.ts";

export interface ProviderCapabilities {
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  supportsImages: boolean;
  supportsAudio: boolean;
  supportsServerThreads: boolean;
  supportsReasoningConfig: boolean;
  supportsPromptCaching: boolean;
  supportsSameTurnToolSchemaPromotion?: boolean;
}

export interface PromptCacheHint {
  key?: string;
  retention?: PromptCacheRetention;
}

export interface PromptCacheUsage {
  cachedTokens?: number;
  promptTokens?: number;
  totalTokens?: number;
}

export interface ModelInvocation {
  model: ModelRef;
  systemPrompt?: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
  }>;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | { name: string };
  reasoning?: {
    effort?: "low" | "medium" | "high" | "xhigh";
  };
  promptCache?: PromptCacheHint;
  threadRef?: string;
  metadata?: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ModelChunk {
  type: "text" | "tool_call" | "event";
  text?: string;
  toolCall?: ModelToolCall;
  raw?: unknown;
}

export interface ModelResult {
  text: string;
  toolCalls?: ModelToolCall[];
  providerThreadRef?: string;
  promptCache?: PromptCacheUsage;
  raw?: unknown;
}

export interface ModelProviderAdapter {
  id: string;
  capabilities: ProviderCapabilities;
  invoke(input: ModelInvocation): Promise<ModelResult>;
  stream?(input: ModelInvocation): AsyncIterable<ModelChunk>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallResult {
  ok: boolean;
  outputText: string;
  raw?: unknown;
}

export interface RuntimeCapabilities {
  supportsSessionResume: boolean;
  supportsCompaction: boolean;
  supportsToolStreaming: boolean;
  supportsParallelToolCalls: boolean;
}

export interface RuntimeSessionHandle {
  sessionId: string;
  role: SessionRole;
  runtimeAdapterId: string;
  runtimeSessionRef?: string;
}

export interface RuntimeSessionInit {
  sessionId: string;
  role: SessionRole;
  workspacePath: string;
  systemPrompt: string;
  tools?: ToolDefinition[];
  metadata?: Record<string, unknown>;
}

export interface RuntimeTurnInput {
  handle: RuntimeSessionHandle;
  provider: ModelProviderAdapter;
  model: ModelRef;
  input: InboundEnvelope | { text: string };
  signal?: AbortSignal;
  toolExecutor?: (call: ModelToolCall) => Promise<ToolCallResult>;
  emitIntermediateDelivery?: (action: OutboundAction, metadata?: Record<string, unknown>) => Promise<void>;
  emitTurnEvent?: (event: RuntimeTurnEventInput) => Promise<void> | void;
  metadata?: Record<string, unknown>;
}

export interface RuntimeTurnResult {
  text: string;
  providerThreadRef?: string;
  runtimeSessionRef?: string;
  deliveries?: OutboundAction[];
  artifacts?: ArtifactRef[];
  raw?: unknown;
}

export interface RuntimeCompactionResult {
  checkpointId: string;
  summary: string;
  raw?: unknown;
}

export interface AgentRuntimeAdapter {
  id: string;
  capabilities: RuntimeCapabilities;
  createSession(input: RuntimeSessionInit): Promise<RuntimeSessionHandle>;
  runTurn(input: RuntimeTurnInput): Promise<RuntimeTurnResult>;
  compactSession?(handle: RuntimeSessionHandle): Promise<RuntimeCompactionResult>;
  closeSession?(handle: RuntimeSessionHandle): Promise<void>;
}

export type SessionLifecycleState = "active" | "closing" | "closed" | "crashed";

export interface SessionTransportBinding {
  transport: string;
  accountId: string;
  peerId: string;
  threadId?: string;
}

export interface SessionBinding {
  sessionId: string;
  role: Exclude<SessionRole, "worker">;
  projectId?: string;
  workspacePath: string;
  runtimeAdapterId: string;
  modelProviderId: string;
  modelRef: ModelRef;
  runtimeSessionRef?: string;
  providerThreadRef?: string;
  transportBindings: SessionTransportBinding[];
}

export interface StoredSessionBinding extends SessionBinding {
  lifecycleState: SessionLifecycleState;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionBindingLookup {
  transport: string;
  accountId: string;
  peerId: string;
  threadId?: string;
  includeInactive?: boolean;
}

export interface WorkerRun {
  workerId: string;
  ownerSessionId: string;
  projectId?: string;
  workspacePath: string;
  runtimeAdapterId: string;
  modelProviderId: string;
  modelRef: ModelRef;
  status: "pending" | "running" | "done" | "failed" | "timed_out";
  requestTranscriptRef: string;
  resultTranscriptRef?: string;
}
