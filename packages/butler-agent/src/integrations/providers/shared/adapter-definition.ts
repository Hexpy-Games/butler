import type { ProviderCapabilities } from "../contracts.ts";
import { parseModelRef } from "../model-ref.ts";
import type { ModelRoundRequest, ModelRoundResult } from "../../../agent/btcc/ports/model-round.ts";
import type {
  PromptOptions,
  PromptTextResult,
} from "../runtime-contracts.ts";
import type {
  ModelProviderId,
  ProviderModelMetadata,
  StructuredDecisionTransport,
} from "../model-catalog.ts";

export interface ProviderAdapterDefinition {
  readonly providerId: ModelProviderId;
  readonly catalog: readonly ProviderModelMetadata[];
  readonly structuredDecisionTransport: StructuredDecisionTransport | null;
  capabilitiesFor(modelRef: string): ProviderCapabilities;
  runPrompt(options: PromptOptions): Promise<PromptTextResult>;
  runRound(request: ModelRoundRequest): Promise<ModelRoundResult>;
}

export function defineProviderAdapter(input: {
  providerId: ModelProviderId;
  catalog: readonly ProviderModelMetadata[];
  structuredDecisionTransport: StructuredDecisionTransport | null;
  runPrompt(options: PromptOptions): Promise<PromptTextResult>;
  runRound(request: ModelRoundRequest): Promise<ModelRoundResult>;
}): ProviderAdapterDefinition {
  return {
    ...input,
    capabilitiesFor(modelRef) {
      const parsed = parseModelRef(modelRef);
      if (parsed.providerId !== input.providerId) {
        throw new Error(`provider_model_mismatch:${input.providerId}:${modelRef}`);
      }
      const metadata = input.catalog.find((model) =>
        model.model_ref === parsed.canonicalRef || model.model_id === parsed.modelId,
      );
      if (!metadata || !metadata.runtime_supported) {
        throw new Error(`provider_model_unavailable:${parsed.canonicalRef}`);
      }
      const supportsStructuredOutputs = input.structuredDecisionTransport !== null;
      const supportsImages = metadata.image_input_verified === true &&
        metadata.image_carrier_protocol !== undefined &&
        metadata.image_endpoint_profile_id?.trim().length !== 0 &&
        metadata.image_capability_revision?.trim().length !== 0 &&
        metadata.image_capability_digest?.trim().length !== 0;
      return {
        supportsStreaming: false,
        supportsToolCalls: supportsStructuredOutputs,
        supportsImages,
        supportsAudio: false,
        supportsServerThreads: false,
        supportsReasoningConfig: true,
        supportsPromptCaching: true,
        supportsSameTurnToolSchemaPromotion: supportsStructuredOutputs,
        supportsStructuredOutputs,
        ...(input.structuredDecisionTransport
          ? { structuredDecisionTransport: input.structuredDecisionTransport }
          : {}),
      };
    },
  };
}
