import sharp from "sharp";
import { extractResponseText } from "../shared/runtime-support.ts";
import {
  createHostedResponse,
} from "../shared/hosted-responses-client.ts";
import type { OpenAIResponse } from "../runtime-contracts.ts";
import {
  findModelMetadata,
  listModelMetadata,
  type ProviderModelMetadata,
} from "../model-catalog.ts";
import {
  readRegisteredHostedModelConfigs,
  recordImageProbeEvidenceForRegisteredModel,
  resolveProviderCredentialSecret,
} from "../shared/registered-models.ts";
import {
  openAIAuthOverrideForHosted,
  resolveHostedRuntimeConfig,
  type HostedRuntimeConfig,
} from "../shared/model-routing.ts";
import { createOpenAIResponse } from "./responses-client.ts";

const SYNTHETIC_PROBE_PROMPT =
  "The attached image is a built-in synthetic 1x1 PNG. Reply exactly IMAGE_PROBE_OK:red only if the visible pixel is solid red; otherwise reply IMAGE_PROBE_FAIL. Do not infer the answer from this instruction.";

function imageProbeModel(modelRef: string): ProviderModelMetadata {
  const model = findModelMetadata(modelRef, listModelMetadata());
  if (!model || model.provider_id !== "openai") {
    throw new Error(`OpenAI image probe requires a registered OpenAI model: ${modelRef}`);
  }
  if (model.image_carrier_protocol !== "openai_responses" ||
      !model.image_endpoint_profile_id ||
      !model.image_capability_revision ||
      !model.image_capability_digest) {
    throw new Error(`OpenAI image capability metadata is incomplete for ${model.model_ref}`);
  }
  return model;
}

async function syntheticRedPngDataUrl(): Promise<string> {
  const bytes = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  }).png().toBuffer();
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function probeBody(model: ProviderModelMetadata, imageDataUrl: string): Record<string, unknown> {
  return {
    model: model.model_id,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: SYNTHETIC_PROBE_PROMPT },
        { type: "input_image", image_url: imageDataUrl },
      ],
    }],
    max_output_tokens: 24,
  };
}

function assertProbeResponse(response: OpenAIResponse): void {
  const text = extractResponseText(response).trim().toLowerCase();
  if (!text.includes("image_probe_ok") || !text.includes("red")) {
    throw new Error("OpenAI image probe response did not identify the synthetic red pixel.");
  }
}

function runtimeConfigForRegisteredRoute(
  modelRef: string,
  butlerData: string,
): HostedRuntimeConfig {
  const registered = readRegisteredHostedModelConfigs(butlerData)
    .find((candidate) => candidate.model_ref === modelRef.trim() || candidate.model_id === modelRef.trim());
  if (!registered || registered.provider_id !== "openai") {
    throw new Error(`OpenAI model is not registered for image probe: ${modelRef}`);
  }
  const resolved = resolveHostedRuntimeConfig(registered.model_ref, butlerData);
  if (!resolved || resolved.providerId !== "openai") {
    throw new Error(`OpenAI hosted route could not be resolved: ${registered.model_ref}`);
  }
  if (resolved.authType === "api_key") {
    const apiKey = resolveProviderCredentialSecret(registered.credential_id, "openai", butlerData);
    if (!apiKey) throw new Error(`OpenAI API-key credential is not registered for ${registered.model_ref}`);
    return { ...resolved, apiKey };
  }
  // Codex OAuth uses the existing OpenAI Responses/Codex transport and its
  // authenticated profile.  No token is copied into probe evidence.
  return resolved;
}

/**
 * Run one bounded, credential-backed synthetic image probe and persist exact
 * route evidence.  The function never accepts user image bytes and never
 * includes credentials or provider response text in its return value.
 */
export async function probeRegisteredOpenAIImageCapability(input: {
  modelRef: string;
  butlerData: string;
  signal?: AbortSignal;
}): Promise<ReturnType<typeof recordImageProbeEvidenceForRegisteredModel>> {
  const model = imageProbeModel(input.modelRef);
  const config = runtimeConfigForRegisteredRoute(input.modelRef, input.butlerData);
  const body = probeBody(model, await syntheticRedPngDataUrl());
  const response = config.authType === "api_key"
    ? await createHostedResponse(
      config,
      body,
      input.signal,
      undefined,
      0,
      { totalTimeoutMs: 60_000, idleTimeoutMs: 20_000 },
    )
    : await createOpenAIResponse(
      body,
      input.signal,
      await openAIAuthOverrideForHosted(config),
      undefined,
      undefined,
      { totalTimeoutMs: 60_000, idleTimeoutMs: 20_000 },
      0,
    );
  assertProbeResponse(response);
  return recordImageProbeEvidenceForRegisteredModel(model.model_ref, input.butlerData);
}
