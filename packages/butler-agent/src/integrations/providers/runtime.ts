import { resolveProviderAdapterDefinition } from "./registry.ts";
import type {
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
} from "../../agent/btcc/ports/model-round.ts";
import type {
  FunctionToolPromptOptions,
  PromptTextResult,
} from "./runtime-contracts.ts";
import { runLegacyFunctionToolPromptText } from "../../agent/btcc/compatibility/legacy-function-tool-prompt.ts";
import type { PromptCacheAwarePromptOptions } from "./prompt-cache-boundary.ts";
import { resolveEffectiveModelRef } from "./shared/model-routing.ts";
import { throwIfAborted } from "./shared/runtime-support.ts";
import {
  openAIBoundedConversationSerializedBytes,
  openAIInitialRequestSerializedBytes,
} from
  "./openai/conversation-items.ts";
import {
  admitVisualImageRequest,
  assertVisualCarrierMatchesCatalog,
  ImageAdmissionError,
} from "../../agent/image-attachment/index.ts";
import { findModelMetadata, listModelMetadata } from "./model-catalog.ts";
import { getButlerData } from "./shared/runtime-support.ts";
import { registeredHostedModelMetadata } from "./shared/registered-models.ts";
import { resolveProviderVisualCapability } from "./registry.ts";

export async function runPromptTextWithUsage(
  options: PromptCacheAwarePromptOptions,
): Promise<PromptTextResult> {
  throwIfAborted(options.signal);
  const model = resolveEffectiveModelRef(options.model);
  const adapter = resolveProviderAdapterDefinition(model);
  return await adapter.runPrompt({ ...options, model });
}
export async function runPromptText(options: PromptCacheAwarePromptOptions): Promise<string> {
  return (await runPromptTextWithUsage(options)).text;
}

/**
 * Legacy test/secondary-caller facade. The semantic loop is BTCC-owned; this
 * facade only translates the older options shape to the one-round port.
 * Guided Turn production composition does not call this function.
 */
export async function runFunctionToolPromptText(
  options: FunctionToolPromptOptions,
): Promise<string> {
  return await runLegacyFunctionToolPromptText(options, createProviderModelRoundPort());
}

export async function runModelRound(
  request: ModelRoundRequest,
): Promise<ModelRoundResult> {
  throwIfAborted(request.signal);
  const model = resolveEffectiveModelRef(request.model);
  const imageManifests = request.imageManifests ?? request.attachments
    ?.flatMap((attachment) => attachment.visualManifest ? [attachment.visualManifest] : []) ?? [];
  if (imageManifests.length > 0) {
    const butlerData = request.butlerData ?? getButlerData();
    const metadata = registeredHostedModelMetadata(butlerData).find((candidate) =>
      candidate.model_ref === model || candidate.model_id === model,
    ) ?? findModelMetadata(model, listModelMetadata());
    const resolvedMetadata = await resolveProviderVisualCapability({
      entry: metadata,
      modelRef: model,
      butlerData,
    });
    if (!request.imageCarrier || !request.imageCapability) {
      throw new ImageAdmissionError("image_carrier_unverified", "frozen_admission_missing");
    }
    if (request.imageCarrier && request.imageCapability) {
      const route = {
        providerId: resolvedMetadata?.provider_id ?? "",
        modelId: resolvedMetadata?.model_id ?? "",
        carrierProtocol: resolvedMetadata?.image_carrier_protocol ?? "fake_vision",
        endpointProfileId: resolvedMetadata?.image_endpoint_profile_id ?? "",
        catalogCapabilityRevision: resolvedMetadata?.image_capability_revision ?? "",
        catalogCapabilityDigest: resolvedMetadata?.image_capability_digest ?? "",
      } as const;
      assertVisualCarrierMatchesCatalog({
        catalogEntry: resolvedMetadata,
        tuple: request.imageCarrier,
        capability: request.imageCapability,
        resolvedRoute: route,
      });
      admitVisualImageRequest({
        tuple: request.imageCarrier,
        capability: request.imageCapability,
        manifests: imageManifests,
      });
    }
  }
  const adapter = resolveProviderAdapterDefinition(model);
  if (request.boundedContinuation?.admitProviderBody && adapter.providerId !== "openai") {
    throw new Error(`bounded_provider_serializer_unsupported:${adapter.providerId}`);
  }
  return await adapter.runRound({
    ...request,
    model,
    ...(imageManifests.length > 0 ? { imageManifests } : {}),
  });
}

export function createProviderModelRoundPort(): ModelRoundPort {
  return {
    runRound: runModelRound,
    initialRequestBytes: openAIInitialRequestSerializedBytes,
    statelessMessageBytes: openAIBoundedConversationSerializedBytes,
  };
}
