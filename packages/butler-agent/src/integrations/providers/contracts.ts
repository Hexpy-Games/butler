import type {
  ModelRef,
  PromptCacheRetention,
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
  supportsStructuredOutputs?: boolean;
  structuredDecisionTransport?: "json_schema" | "function_tool";
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
  signal?: AbortSignal;
  promptCache?: PromptCacheHint;
  responseFormat?: {
    type: "json_schema";
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
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
  capabilitiesFor?(model: ModelRef): ProviderCapabilities;
  forModel?(model: ModelRef): ModelProviderAdapter;
  invoke(input: ModelInvocation): Promise<ModelResult>;
  stream?(input: ModelInvocation): AsyncIterable<ModelChunk>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

