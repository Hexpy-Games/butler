import type {
  ModelRoundMessage,
  ModelRoundPort,
  ModelRoundResult,
  ModelRoundTool,
  ModelRoundToolCall,
} from "../ports/model-round.ts";
import type {
  PromptUsageAttribution,
  ProviderStreamProjectionHandler,
  ReasoningEffort,
} from "../../../integrations/providers/runtime-contracts.ts";
import type { AttachmentRef } from "../../../gateways/core/contracts.ts";

export type BtccAgentLoopMessage = ModelRoundMessage;
export type BtccAgentLoopToolDefinition = ModelRoundTool;
export type BtccAgentLoopToolCall = ModelRoundToolCall;

export interface BtccAgentLoopToolResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export type BtccTextToolCallDisposition =
  | { status: "continue"; observation: string }
  | { status: "fail"; error?: unknown };

export interface BtccFinalSynthesisOptions {
  instructions: string;
  retryInstructions?: string;
  maxAttempts?: number;
  includeInstructionsInMessages?: boolean;
  triggerAfterToolCandidate?: boolean;
  triggerAfterToolEmpty?: boolean;
  acceptCandidate?: (input: {
    text: string;
    response: ModelRoundResult;
  }) => Promise<boolean> | boolean;
  acceptText?: (input: {
    text: string;
    response: ModelRoundResult;
    attempt: number;
  }) => Promise<string | null | undefined> | string | null | undefined;
  onFailure?: (error: unknown) => void;
  propagateFailure?: boolean;
  onExhausted?: (input: {
    text: string;
    response?: ModelRoundResult;
  }) => Promise<string | never> | string | never;
}

export interface BtccAgentLoopInput {
  prompt: string;
  model?: string;
  instructions?: string;
  reasoningEffort?: ReasoningEffort;
  cacheScope?: string;
  signal?: AbortSignal;
  attachments?: readonly AttachmentRef[];
  butlerData?: string;
  usageAttribution?: PromptUsageAttribution;
  onProviderStreamEvent?: ProviderStreamProjectionHandler;
  onProviderResponseIdentity?: (identity: {
    provider: string;
    configuredModel: string;
    reportedModel: string;
  }) => void;
  providerRetryAttempts?: number;
  toolChoice?: "auto" | "required";
  tools: readonly BtccAgentLoopToolDefinition[];
  resolveTools?: () => readonly BtccAgentLoopToolDefinition[];
  resolveToolChoice?: () => "auto" | "required" | undefined;
  modelRound: ModelRoundPort;
  maxIterations?: number;
  onAssistantTextBeforeTools?: (input: {
    text: string;
    toolCalls: BtccAgentLoopToolCall[];
    iteration: number;
  }) => Promise<void> | void;
  executeTool: (call: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    rawArguments: string;
    signal?: AbortSignal;
  }) => Promise<unknown>;
  onTextToolCalls?: (input: {
    names: string[];
    toolCalls: BtccAgentLoopToolCall[];
    text: string;
    iteration: number;
  }) => Promise<BtccTextToolCallDisposition> | BtccTextToolCallDisposition;
  finalTextFromToolResult?: (input: {
    toolCall: BtccAgentLoopToolCall;
    toolResult: BtccAgentLoopToolResult;
  }) => Promise<string | null | undefined> | string | null | undefined;
  reviewFinalCandidate?: (input: {
    text: string;
    iteration: number;
  }) => Promise<
    | { status: "accepted"; text?: string }
    | { status: "continue"; observation: string }
  > | (
    | { status: "accepted"; text?: string }
    | { status: "continue"; observation: string }
  );
  onEvent?: (event: BtccAgentLoopEvent) => void;
  onLoopLimit?: (input: {
    messages: BtccAgentLoopMessage[];
    toolResults: BtccAgentLoopToolResult[];
    maxIterations: number;
  }) => Promise<string> | string;
  finalSynthesis?: BtccFinalSynthesisOptions;
}

export interface BtccAgentLoopEvent {
  type: "model_call" | "model_response" | "tool_call" | "tool_result" | "loop_limit";
  iteration: number;
  toolCall?: BtccAgentLoopToolCall;
  toolResult?: BtccAgentLoopToolResult;
  text?: string;
}

export interface BtccAgentLoopOutput {
  finalText: string;
  messages: BtccAgentLoopMessage[];
  events: BtccAgentLoopEvent[];
  stoppedByLimit: boolean;
}
