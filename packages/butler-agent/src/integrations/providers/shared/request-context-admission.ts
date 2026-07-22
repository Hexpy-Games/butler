import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { resolveModelMetadata, type ModelProviderId } from "../model-catalog.ts";
import { parseModelRef } from "../model-ref.ts";
import {
  modelRequestContextAdmissionMetric,
  type ModelRequestContextAdmissionMetric,
} from "./request-context-admission-metrics.ts";
import { compileCompletedToolEvidencePointers } from "../../../agent/context/completed-tool-evidence.ts";
import type { PromptUsageAttribution } from "../runtime-contracts.ts";
import { estimateTokensForModel } from "../model-catalog.ts";

export type RequestContextMeasurement = "model_token_estimate";
export type RequestContextAdmission = "admitted" | "reduce" | "cannot_fit_required";

export interface ContextAtomRef {
  kind: string;
  id: string;
  source_hash: string;
  required: boolean;
  serialized_tokens: number;
}

export interface ModelRequestContextPlan {
  request_id: string;
  turn_id: string;
  generation: number;
  model_ref: string;
  context_window_tokens: number;
  requested_output_tokens: number;
  max_input_tokens: number | null;
  provider_envelope_tokens: number;
  input_capacity_tokens: number;
  measurement: RequestContextMeasurement;
  required_atoms: ContextAtomRef[];
  optional_atoms: ContextAtomRef[];
  tool_schema_tokens: number;
  compiled_input_tokens: number;
  budget_input_tokens: number | null;
  admission: RequestContextAdmission;
}

export interface ModelRequestAdmissionReceipt {
  serialized_request_sha256: string;
  serialized_request: string;
  plan: ModelRequestContextPlan;
  metric: ModelRequestContextAdmissionMetric;
}

export class ModelRequestAdmissionError extends Error {
  readonly code:
    | "model_request_metadata_unknown"
    | "model_request_output_capacity_exceeded"
    | "model_request_context_capacity_exceeded";
  readonly plan: ModelRequestContextPlan | null;

  constructor(input: {
    code: ModelRequestAdmissionError["code"];
    message: string;
    plan?: ModelRequestContextPlan | null;
  }) {
    super(input.message);
    this.name = "ModelRequestAdmissionError";
    this.code = input.code;
    this.plan = input.plan ?? null;
  }
}

interface AdmitSerializedProviderRequestInput {
  providerId: ModelProviderId;
  modelRef: string;
  body: Record<string, unknown>;
  requestedOutputTokens?: number;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  maxInputTokens?: number | null;
  providerEnvelopeTokens?: number;
  turnId?: string;
  generation?: number;
  requiredAtoms?: ContextAtomRef[];
  optionalAtoms?: ContextAtomRef[];
  toolSchemaTokens?: number;
  usageAttribution?: PromptUsageAttribution;
  roundIndex?: number;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function strictModelCapacity(input: AdmitSerializedProviderRequestInput): {
  modelRef: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
} {
  const parsed = parseModelRef(input.modelRef);
  const capacityModelId = input.providerId === "openai" && parsed.modelId.endsWith("-codex")
    ? parsed.modelId.slice(0, -"-codex".length)
    : parsed.modelId;
  const metadata = resolveModelMetadata(`${input.providerId}/${capacityModelId}`);
  const metadataMatches = metadata.provider_id === input.providerId && metadata.model_id === capacityModelId;
  const contextWindowTokens = positiveInteger(input.contextWindowTokens) ??
    (metadataMatches ? positiveInteger(metadata.context_window_tokens) : null);
  const maxOutputTokens = positiveInteger(input.maxOutputTokens) ??
    (metadataMatches ? positiveInteger(metadata.max_output_tokens) : null);
  if (!contextWindowTokens || !maxOutputTokens) {
    throw new ModelRequestAdmissionError({
      code: "model_request_metadata_unknown",
      message: `No exact context capacity is registered for ${input.providerId}/${parsed.modelId}.`,
    });
  }
  return {
    modelRef: `${input.providerId}/${parsed.modelId}`,
    contextWindowTokens,
    maxOutputTokens,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function admitSerializedProviderRequest(
  input: AdmitSerializedProviderRequestInput,
): ModelRequestAdmissionReceipt {
  const capacity = strictModelCapacity(input);
  const requestedOutputTokens = positiveInteger(input.requestedOutputTokens) ?? capacity.maxOutputTokens;
  const providerEnvelopeTokens = Math.max(0, Math.trunc(input.providerEnvelopeTokens ?? 0));
  const configuredInputCapacity = positiveInteger(input.maxInputTokens);
  const contextInputCapacity = capacity.contextWindowTokens - requestedOutputTokens;
  const inputCapacityTokens = Math.min(
    configuredInputCapacity ?? capacity.contextWindowTokens,
    contextInputCapacity,
  );
  const compiledBody = compileCompletedToolEvidencePointers({
    body: input.body,
    maxSerializedTokens: Math.max(0, inputCapacityTokens - providerEnvelopeTokens),
    measureSerializedTokens: (value) =>
      estimateTokensForModel(JSON.stringify(value), capacity.modelRef).tokens,
  });
  const serializedRequest = JSON.stringify(compiledBody);
  const serializedRequestHash = sha256(serializedRequest);
  const estimatedInputTokens = estimateTokensForModel(serializedRequest, capacity.modelRef).tokens;
  const compiledInputTokens = estimatedInputTokens + providerEnvelopeTokens;
  const plan: ModelRequestContextPlan = {
    request_id: `request-${serializedRequestHash.slice(0, 24)}`,
    turn_id: input.turnId?.trim() || "unattributed",
    generation: Math.max(0, Math.trunc(input.generation ?? 0)),
    model_ref: capacity.modelRef,
    context_window_tokens: capacity.contextWindowTokens,
    requested_output_tokens: requestedOutputTokens,
    max_input_tokens: configuredInputCapacity,
    provider_envelope_tokens: providerEnvelopeTokens,
    input_capacity_tokens: Math.max(0, inputCapacityTokens),
    measurement: "model_token_estimate",
    required_atoms: [...(input.requiredAtoms ?? [])],
    optional_atoms: [...(input.optionalAtoms ?? [])],
    tool_schema_tokens: Math.max(0, Math.trunc(
      input.toolSchemaTokens ?? Buffer.byteLength(JSON.stringify(input.body.tools ?? []), "utf8"),
    )),
    compiled_input_tokens: compiledInputTokens,
    budget_input_tokens: null,
    admission: compiledInputTokens <= inputCapacityTokens ? "admitted" : "reduce",
  };

  if (requestedOutputTokens > capacity.maxOutputTokens || requestedOutputTokens >= capacity.contextWindowTokens) {
    plan.admission = "cannot_fit_required";
    throw new ModelRequestAdmissionError({
      code: "model_request_output_capacity_exceeded",
      message: `Requested output capacity exceeds the registered limit for ${capacity.modelRef}.`,
      plan,
    });
  }
  if (plan.admission !== "admitted") {
    throw new ModelRequestAdmissionError({
      code: "model_request_context_capacity_exceeded",
      message: `Serialized model request does not fit the registered context capacity for ${capacity.modelRef}.`,
      plan,
    });
  }
  plan.budget_input_tokens = compiledInputTokens;
  input.usageAttribution?.beforeAdmittedModelRequest?.({
    roundIndex: Math.max(0, Math.trunc(input.roundIndex ?? input.usageAttribution.roundIndex ?? 0)),
    phase: input.usageAttribution.phase,
    admittedPromptTokens: plan.budget_input_tokens,
    requestedOutputTokens: plan.requested_output_tokens,
    requestHash: serializedRequestHash,
  });
  return {
    serialized_request_sha256: serializedRequestHash,
    serialized_request: serializedRequest,
    plan,
    metric: modelRequestContextAdmissionMetric(plan),
  };
}
