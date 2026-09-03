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
  PhaseContinuityPrivateDigester,
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
import type { OperationResultReplay } from "../operation-result-replay/index.ts";
import type { TurnContinuationBudgetState } from "../turn/index.ts";
import type { BtccRoundToolSurfaceSnapshot } from "./round-tool-surface.ts";
import type { BtccFinalArtifact } from "../contracts.ts";
import type { ChangedFileDetail } from "../../tools/file-tools/shared/changed-file-detail.ts";
import type { RuntimeMemoryAttributionPort } from
  "../../../operations/diagnostics/runtime-memory-attribution/index.ts";

export type BtccAgentLoopMessage = ModelRoundMessage;
export type BtccAgentLoopToolDefinition = ModelRoundTool;
export type BtccAgentLoopToolCall = ModelRoundToolCall;

export type BtccAgentLoopResult = {
  content: string;
  terminalOutcome?: "no_visible";
  executionOutcome?: "waiting_for_worker";
  route: "direct" | "assisted" | "managed";
  workStatus?: "completed" | "blocked";
  artifacts?: BtccFinalArtifact[];
  changedFiles?: ChangedFileDetail[];
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
    memoryAttribution?: RuntimeMemoryAttributionPort;
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
    transitionContinuationBudget?: (
      event: import("../turn/index.ts").TurnContinuationBudgetEvent,
    ) => Promise<import("../turn/index.ts").TurnContinuationBudgetState>;
  }): Promise<BtccAgentLoopResult>;
}

export interface BtccAgentLoopToolError {
  code: string;
  message: string;
  field?: string;
}

export type BtccAgentLoopToolResult = {
  toolCallId: string;
  name: string;
  ok: true;
  output: unknown;
} | {
  toolCallId: string;
  name: string;
  ok: false;
  error: BtccAgentLoopToolError;
  output?: unknown;
};

export type BtccTextToolCallDisposition =
  | { status: "continue"; observation: string }
  | { status: "fail"; error?: unknown };

export type BtccAfterToolBatchDisposition = "continue" | "final_report" | "wait";

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
  phaseContinuityPrivateDigester?: PhaseContinuityPrivateDigester;
  turnId?: string;
  recoveryAttempt?: number;
  model?: string;
  resolveModelRef?: () => string;
  instructions?: string;
  reasoningEffort?: ReasoningEffort;
  cacheScope?: string;
  stableProviderCachePrefix?: import("../ports/model-round.ts").StableProviderCachePrefixContract;
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
  resolveTools?: () => BtccRoundToolSurfaceSnapshot | Promise<BtccRoundToolSurfaceSnapshot>;
  resolveToolChoice?: () => "auto" | "required" | undefined;
  modelRound: ModelRoundPort;
  operationResultReplay?: OperationResultReplay;
  continuationBudget?: {
    state: TurnContinuationBudgetState;
    admitRequest(input: {
      roundId: string; requestDigest: string; modelFacingBytes: number;
    }): Promise<void>;
    recordOutput(input: { roundId: string; outputBytes: number }): Promise<void>;
    recordToolRound(input: { roundId: string }): Promise<void>;
  };
  /** Context selection only; never enables execution-budget termination. */
  maxModelFacingBytes?: number;
  /** Consume new steering before assigning item identities and selecting context. */
  beforeModelRound?: () => Promise<readonly string[]>;
  resolveOperationResultCallId?: (providerCallId: string) => string | undefined;
  onAssistantTextBeforeTools?: (input: {
    text: string;
    toolCalls: BtccAgentLoopToolCall[];
    iteration: number;
  }) => Promise<void> | void;
  afterToolBatch?: (input: {
    toolCalls: readonly BtccAgentLoopToolCall[];
    toolResults: readonly BtccAgentLoopToolResult[];
    iteration: number;
  }) => Promise<BtccAfterToolBatchDisposition> | BtccAfterToolBatchDisposition;
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
    | { status: "wait" }
    | { status: "continue"; observation: string }
  > | (
    | { status: "accepted"; text?: string }
    | { status: "wait" }
    | { status: "continue"; observation: string }
  );
  onEvent?: (event: BtccAgentLoopEvent) => void;
  finalSynthesis?: BtccFinalSynthesisOptions;
}

export interface BtccAgentLoopEvent {
  type:
    | "model_call"
    | "model_response"
    | "model_failure"
    | "tool_call"
    | "tool_result";
  iteration: number;
  toolCall?: BtccAgentLoopToolCall;
  toolResult?: BtccAgentLoopToolResult;
  text?: string;
}

export interface BtccAgentLoopOutput {
  finalText: string;
  executionOutcome?: "waiting_for_worker";
  messages: BtccAgentLoopMessage[];
  events: BtccAgentLoopEvent[];
}
