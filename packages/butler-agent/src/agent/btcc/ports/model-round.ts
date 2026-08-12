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
import type {
  M1CacheBoundaryEvidence,
  M1RequestSegmentSource,
} from "./provider-request-attribution.ts";

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
  /** Observation-only source kind for the exact provider-visible content. */
  requestSegmentKind?: M1RequestSegmentSource["kind"];
  /** BTCC-owned compact replay projection; providers may only translate it. */
  operationResultReference?: OperationResultReferenceCarrier;
  /** BTCC journal identity; never serialized as provider content. */
  operationResultCallId?: string;
  /** Turn-local stable identity; never serialized as provider content. */
  continuationItemId?: string;
}

export interface OperationResultReferenceCarrier {
  version: "butler.operation-result-reference.v1";
  kind: "operation_result";
  identity: {
    kind: "direct" | "work";
    result_ref: string;
    tool_name: string;
    work_id?: string;
  };
  integrity: { sha256: string; revision: number | null };
  outcome: {
    status: "completed";
    success: boolean;
    verification: "stored_exact_available";
    error_code?: string;
  };
  availability: {
    status: "exact_read_available" | "reference_only";
    capability: "read_operation_results";
    scope: "same_turn" | "work_scope";
  };
}

export interface ModelRoundTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  concurrencySafe?: boolean;
}

export interface StableProviderCachePrefixContract {
  schemaVersion: "butler.stable-provider-cache-prefix.v1";
  stablePrefixRevision: string;
  toolProfileRevision: string;
  /** Existing Tool Instruction Surface owner; never rebuilt by the provider. */
  instructionPrefix: string;
}

export interface ProviderRouteCacheIdentity {
  schemaVersion: "butler.provider-route-cache-identity.v1";
  routeDigest: string;
  routeCursor: number;
  providerId: "openai" | "openai-codex";
  modelRef: string;
  authMode: "api_key" | "codex_subscription" | "codex_oauth";
  capabilityDigest: string;
  serializerContract:
    | "butler.openai-responses-final-json.v1"
    | "butler.openai-codex-final-json.v1";
  toolProfileRevision: string;
  stablePrefixRevision: string;
  serializedStablePrefixSha256: string;
  serializedStablePrefixBytes: number;
}

export type StableProviderPrefixInvariantCode =
  | "stable_provider_prefix_contract_invalid"
  | "stable_provider_prefix_instruction_mismatch"
  | "stable_provider_prefix_dynamic_collision"
  | "stable_provider_prefix_route_context_missing"
  | "stable_provider_prefix_route_context_invalid"
  | "stable_provider_prefix_route_model_mismatch"
  | "stable_provider_prefix_previous_identity_missing"
  | "stable_provider_prefix_serializer_order_invalid"
  | "stable_provider_prefix_final_bytes_mismatch"
  | "stable_provider_prefix_route_identity_mismatch"
  | "stable_provider_prefix_retry_identity_changed";

/** Provider-neutral invariant: adapters construct it; route authority surfaces it. */
export class StableProviderPrefixInvariantError extends Error {
  constructor(readonly code: StableProviderPrefixInvariantCode) {
    super(code);
    this.name = "StableProviderPrefixInvariantError";
  }
}

export function stableProviderPrefixInvariant(
  code: StableProviderPrefixInvariantCode,
): StableProviderPrefixInvariantError {
  return new StableProviderPrefixInvariantError(code);
}

/** Route-owned, bounded compatibility facts attached by createModelRoutePort. */
export interface ModelRouteRequestContext {
  schemaVersion: "butler.model-route-request.v1";
  routeDigest: string;
  cursor: number;
  modelRef: string;
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
  requestSegmentSources?: Partial<Record<
    "instructions" | "input",
    readonly M1RequestSegmentSource[]
  >>;
  cacheScope?: string;
  attributionArmId?: string;
  cacheBoundaryEvidence?: M1CacheBoundaryEvidence;
  /** Present only on the existing default-off phase-minimal selection path. */
  stableProviderCachePrefix?: StableProviderCachePrefixContract;
  /** Set only by createModelRoutePort; adapters must fail closed if required and absent. */
  routeContext?: ModelRouteRequestContext;
  providerRetryAttempts?: number;
  /** Zero-based physical provider attempt offset owned by the route journal. */
  routeTransportAttemptOrdinal?: number;
  /** Opaque provider continuation returned by the preceding round. */
  continuation?: unknown;
  /** Turn-owned bounded carrier selection; provider adapters may only translate it. */
  boundedContinuation?: {
    schemaVersion: "butler.turn-context-envelope.v1";
    modelFacingBytes: number;
    requestDigest: string;
    responseItemId: string;
    /** Required exact serialized-body admission owned by the durable Turn. */
    admitProviderBody(serializedBytes: number): Promise<void>;
  };
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
  /** Durable route acceptance checkpoint. Only the routed-round authority sets this. */
  acceptedCheckpoint?: {
    roundId: string;
    candidateIndex: number;
    transportAttempt: number;
    modelRef: string;
  };
}

export interface ModelRoundPort {
  /** Performs exactly one provider model request and returns its normalized response. */
  runRound(request: ModelRoundRequest): Promise<ModelRoundResult>;
}
