import type {
  ModelRouteAttemptHistory,
  ModelRouteEventResult,
} from "../model-route/index.ts";
import type {
  ModelRoundMessage,
  ModelRoundPort,
  ModelRoundResult,
  ModelRoundTool,
  ModelRoundToolCall,
} from "../ports/model-round.ts";
import type {
  ImageCapabilityEvidence,
  ImageCarrierTuple,
  VerifiedImagePayloadPort,
  VisualAdmittedManifest,
} from "../../image-attachment/index.ts";
import type { BtccTurnProgressObserver } from "../contracts.ts";
import type { TurnRecord } from "../turn/index.ts";
import type {
  PromptUsageAttribution,
  ProviderStreamProjectionHandler,
  ReasoningEffort,
} from "../../../integrations/providers/runtime-contracts.ts";
import type { AttachmentRef } from "../../../gateways/core/contracts.ts";
import type { BtccFinalArtifact } from "../contracts.ts";

export type BtccAgentLoopMessage = ModelRoundMessage;
export type BtccAgentLoopToolDefinition = ModelRoundTool;
export type BtccAgentLoopToolCall = ModelRoundToolCall;

export type BtccAgentLoopResult = {
  content: string;
  route: "direct" | "assisted" | "managed";
  artifacts?: BtccFinalArtifact[];
  modelIdentity?: {
    requestedModelRef: string;
    effectiveModelRef: string;
    providerReportedModelRef?: string;
  };
};

export interface BtccAgentLoop {
  run(input: {
    turn: TurnRecord;
    recoveryAttempt?: number;
    signal: AbortSignal;
    progress?: BtccTurnProgressObserver;
    onProviderResponseIdentity?: (identity: {
      provider: string;
      configuredModel: string;
      reportedModel: string;
    }) => void;
    recordModelRouteEvent?: (input: {
      type: string;
      roundId: string;
      candidateIndex: number;
      transportAttempt?: number;
      modelRef: string;
      errorCode?: string;
      failureDisposition?: import("../model-route/index.ts").ModelRouteFailureDisposition;
      route?: import("../model-route/index.ts").ModelRouteState;
    }) => Promise<ModelRouteEventResult | void>;
    loadModelRouteAttemptHistory?: (input: {
      roundId: string;
      candidateIndex: number;
      modelRef: string;
    }) => Promise<ModelRouteAttemptHistory>;
    loadModelRoundAcceptance?: (input: {
      roundId: string;
      candidateIndex: number;
      modelRef: string;
    }) => Promise<import("../ports/model-round.ts").ModelRoundResult | undefined>;
    recordModelRoundAcceptance?: (input: {
      roundId: string;
      candidateIndex: number;
      transportAttempt: number;
      modelRef: string;
      result: import("../ports/model-round.ts").ModelRoundResult;
    }) => Promise<void>;
  }): Promise<BtccAgentLoopResult>;
}

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
  turnId?: string;
  recoveryAttempt?: number;
  model?: string;
  resolveModelRef?: () => string;
  instructions?: string;
  reasoningEffort?: ReasoningEffort;
  cacheScope?: string;
  signal?: AbortSignal;
  attachments?: readonly AttachmentRef[];
  imageCarrier?: ImageCarrierTuple;
  imageCapability?: ImageCapabilityEvidence;
  imageManifests?: readonly VisualAdmittedManifest[];
  verifiedImagePayloadPort?: VerifiedImagePayloadPort;
  butlerData?: string;
  usageAttribution?: PromptUsageAttribution;
  onProviderStreamEvent?: ProviderStreamProjectionHandler;
  onProviderResponseIdentity?: (identity: {
    provider: string;
    configuredModel: string;
    reportedModel: string;
  }) => void;
  providerRetryAttempts?: number;
  progress?: BtccTurnProgressObserver;
  toolChoice?: "auto" | "required";
  tools: readonly BtccAgentLoopToolDefinition[];
  resolveTools?: () => readonly BtccAgentLoopToolDefinition[];
  resolveToolChoice?: () => "auto" | "required" | undefined;
  modelRound: ModelRoundPort;
  /**
   * The execution window is an internal scheduling boundary, not a semantic
   * model/tool budget. A guided caller supplies this callback to reread
   * durable Work and append one internal observation before the next window.
   */
  onExecutionWindowBoundary?: (input: {
    windowIndex: number;
    iteration: number;
    messages: readonly BtccAgentLoopMessage[];
    toolResults: readonly BtccAgentLoopToolResult[];
  }) => Promise<string | undefined> | string | undefined;
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
  type:
    | "model_call"
    | "model_response"
    | "tool_call"
    | "tool_result"
    | "execution_window_boundary";
  iteration: number;
  windowIndex?: number;
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
