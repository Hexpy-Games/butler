import type {
  AttachmentRef,
  ModelRef,
} from "../../../gateways/core/contracts.ts";
import type {
  PromptUsageAttribution,
  PromptUsageReport,
  ProviderStreamProjectionHandler,
  ReasoningEffort,
} from "../../../integrations/providers/runtime-contracts.ts";
import { digest, stableJson } from "../identity/index.ts";

export type ModelRoundRole = "system" | "user" | "assistant" | "tool";

export interface ModelRoundToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
  /** Provider protocol origin; BTCC decides whether and how to execute it. */
  origin?: "native" | "text";
}

export interface ModelRoundImageAttachment {
  path: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  name: string;
}

export interface ModelRoundMessage {
  role: ModelRoundRole;
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: readonly ModelRoundToolCall[];
  imageAttachments?: readonly ModelRoundImageAttachment[];
  /** Provider-owned protocol data. BTCC stores and returns it without interpreting it. */
  providerData?: unknown;
}

export interface ModelRoundTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  concurrencySafe?: boolean;
}

export interface ModelRoundRequest {
  roundId?: string;
  model: ModelRef | string;
  messages: readonly ModelRoundMessage[];
  instructions?: string;
  tools: readonly ModelRoundTool[];
  toolChoice?: "auto" | "required";
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  attachments?: readonly AttachmentRef[];
  butlerData?: string;
  usageAttribution?: PromptUsageAttribution;
  cacheScope?: string;
  providerRetryAttempts?: number;
  /** Opaque provider continuation returned by the preceding round. */
  continuation?: unknown;
  onProviderStreamEvent?: ProviderStreamProjectionHandler;
  onProviderResponseIdentity?: (identity: {
    provider: string;
    configuredModel: string;
    reportedModel: string;
  }) => void;
}

export interface ModelRoundResult {
  text?: string;
  toolCalls: ModelRoundToolCall[];
  /** Names found in provider text that looked like a tool call but were not structured calls. */
  textToolCallNames?: string[];
  /** Provider-normalized assistant message, including protocol data when needed. */
  assistantMessage?: ModelRoundMessage;
  /** Opaque provider continuation to pass to the next BTCC-owned round. */
  continuation?: unknown;
  usage?: PromptUsageReport | null;
  providerIdentity?: {
    provider: string;
    configuredModel: string;
    reportedModel: string;
  };
  raw?: unknown;
}

export interface ModelRoundPort {
  /** Performs exactly one provider model request and returns its normalized response. */
  runRound(request: ModelRoundRequest): Promise<ModelRoundResult>;
}

/** Required by bounded continuation so evidence describes the dispatched adapter input. */
export interface PreparedModelRoundPort extends ModelRoundPort {
  prepareRequest(request: ModelRoundRequest): ModelRoundRequest;
}

/** Digest-only request identity for durable route no-progress evidence. */
export function modelRoundRequestDigest(request: ModelRoundRequest): string {
  return digest(modelRoundRequestProjection(request));
}

export function modelRoundRequestSerializedBytes(
  request: ModelRoundRequest,
): number {
  return Buffer.byteLength(modelRoundRequestProjection(request), "utf8");
}

function modelRoundRequestProjection(request: ModelRoundRequest): string {
  const projection = {
    roundId: request.roundId ?? null,
    model: request.model,
    messages: request.messages,
    instructions: request.instructions ?? null,
    tools: request.tools,
    toolChoice: request.toolChoice ?? null,
    reasoningEffort: request.reasoningEffort ?? null,
    attachments: request.attachments ?? [],
    butlerData: request.butlerData ?? null,
    usageAttribution: request.usageAttribution ?? null,
    cacheScope: request.cacheScope ?? null,
    providerRetryAttempts: request.providerRetryAttempts ?? null,
    continuation: request.continuation ?? null,
  };
  const serialized = JSON.stringify(projection);
  if (serialized === undefined) {
    throw new Error("BTCC model request evidence is not JSON serializable");
  }
  return stableJson(JSON.parse(serialized) as unknown);
}
