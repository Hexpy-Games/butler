import type { ToolEvidenceRetentionContext } from "../context/tool-evidence-retention.ts";

export type AgentLoopRole = "system" | "user" | "assistant" | "tool";

export interface AgentLoopMessage {
  role: AgentLoopRole;
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface AgentLoopToolDefinition {
  name: string;
  description: string;
  inputSchema?: {
    type: "object";
    required?: string[];
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  concurrencySafe?: boolean;
}

export interface AgentLoopToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentLoopToolResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface AgentLoopModelResponse {
  text?: string;
  toolCalls?: AgentLoopToolCall[];
  raw?: unknown;
}

export interface AgentLoopModelInput {
  messages: AgentLoopMessage[];
  tools: AgentLoopToolDefinition[];
  iteration: number;
}

export interface AgentLoopEvent {
  type: "model_call" | "model_response" | "tool_call" | "tool_result" | "loop_limit";
  iteration: number;
  toolCall?: AgentLoopToolCall;
  toolResult?: AgentLoopToolResult;
  text?: string;
}

export interface AgentLoopInput {
  messages: AgentLoopMessage[];
  tools: AgentLoopToolDefinition[];
  maxIterations?: number;
  evidenceRetention?: ToolEvidenceRetentionContext;
  callModel: (input: AgentLoopModelInput) => Promise<AgentLoopModelResponse>;
  onAssistantTextBeforeTools?: (input: {
    text: string;
    toolCalls: AgentLoopToolCall[];
    iteration: number;
  }) => Promise<void> | void;
  executeTool: (call: AgentLoopToolCall) => Promise<unknown>;
  finalTextFromToolResult?: (input: {
    toolCall: AgentLoopToolCall;
    toolResult: AgentLoopToolResult;
  }) => Promise<string | null | undefined> | string | null | undefined;
  reviewFinalCandidate?: (input: {
    text: string;
    iteration: number;
  }) => Promise<
    | { status: "accepted"; text?: string }
    | { status: "continue"; observation: string }
  >;
  onEvent?: (event: AgentLoopEvent) => void;
  onLoopLimit?: (input: {
    messages: AgentLoopMessage[];
    toolResults: AgentLoopToolResult[];
    maxIterations: number;
  }) => Promise<string> | string;
}

export interface AgentLoopOutput {
  finalText: string;
  messages: AgentLoopMessage[];
  events: AgentLoopEvent[];
  stoppedByLimit: boolean;
}
