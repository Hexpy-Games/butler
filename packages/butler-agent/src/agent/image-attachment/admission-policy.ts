import {
  ImageAdmissionError,
  type ImageCapabilityCatalogEntry,
  type ImageCapabilityEvidence,
  type ImageCarrierTuple,
  type ResolvedImageRoute,
  type VisualAdmittedManifest,
  type VisualAdmissionMemo,
  type VisualImageAdmissionInput,
  type VisualImageAdmissionResult,
} from "./contracts.ts";
import { freezeVisualManifest } from "./sanitizer.ts";

function carrierFromCatalog(entry: ImageCapabilityCatalogEntry): ImageCarrierTuple {
  const carrierProtocol = entry.image_carrier_protocol ?? hostedShapeToCarrier(entry.hosted_api_shape);
  const values = {
    providerId: entry.provider_id.trim(),
    modelId: entry.model_id.trim(),
    carrierProtocol,
    endpointProfileId: entry.image_endpoint_profile_id?.trim(),
    catalogCapabilityRevision: entry.image_capability_revision?.trim(),
    catalogCapabilityDigest: entry.image_capability_digest?.trim(),
  };
  if (!values.providerId || !values.modelId || !values.carrierProtocol || !values.endpointProfileId ||
      !values.catalogCapabilityRevision || !values.catalogCapabilityDigest) {
    throw new ImageAdmissionError("image_carrier_unavailable", "catalog_tuple_incomplete");
  }
  return values as ImageCarrierTuple;
}

function evidenceFromCatalog(
  entry: ImageCapabilityCatalogEntry,
  tuple: ImageCarrierTuple,
): ImageCapabilityEvidence {
  const sourceUrl = entry.image_capability_source_url?.trim();
  const verifiedAt = entry.image_capability_verified_at?.trim();
  if (!sourceUrl || !verifiedAt) {
    throw new ImageAdmissionError("image_carrier_unverified", "catalog_evidence_incomplete");
  }
  return {
    ...tuple,
    ...(entry.credential_id ? { credentialId: entry.credential_id } : {}),
    modelSupport: entry.image_input_support ?? "unknown",
    capabilitySource: entry.image_capability_source ?? "unknown",
    routeHealth: entry.image_route_health ?? "unchecked",
    inputModalities: [...(entry.image_input_modalities ?? [])],
    acceptedMimeTypes: [...(entry.image_accepted_mime_types ?? [])],
    maxInlineImageBytes: entry.image_max_inline_bytes ?? 0,
    maxWidth: entry.image_max_width ?? 0,
    maxHeight: entry.image_max_height ?? 0,
    maxPixels: entry.image_max_pixels ?? 0,
    sourceUrl,
    verifiedAt,
    evidenceRevision: tuple.catalogCapabilityRevision,
    evidenceDigest: tuple.catalogCapabilityDigest,
    ...(entry.image_tool_server_id ? { toolServerId: entry.image_tool_server_id } : {}),
    ...(entry.image_tool_name ? { toolName: entry.image_tool_name } : {}),
    ...(entry.image_tool_capability_digest
      ? { toolCapabilityDigest: entry.image_tool_capability_digest }
      : {}),
  };
}

function hostedShapeToCarrier(shape: string | undefined): ImageCarrierTuple["carrierProtocol"] | undefined {
  if (shape === "openai_responses") return "openai_responses";
  if (shape === "openai_chat_completions") return "openai_chat_completions";
  return undefined;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertTupleEqual(actual: ImageCarrierTuple, expected: ImageCarrierTuple): void {
  if (actual.providerId !== expected.providerId || actual.modelId !== expected.modelId ||
      actual.carrierProtocol !== expected.carrierProtocol ||
      actual.endpointProfileId !== expected.endpointProfileId ||
      actual.catalogCapabilityRevision !== expected.catalogCapabilityRevision ||
      actual.catalogCapabilityDigest !== expected.catalogCapabilityDigest) {
    throw new ImageAdmissionError("image_carrier_unverified", "caller_tuple_catalog_mismatch");
  }
}

function assertEvidenceEqual(actual: ImageCapabilityEvidence, expected: ImageCapabilityEvidence): void {
  if (actual.providerId !== expected.providerId || actual.modelId !== expected.modelId ||
      actual.credentialId !== expected.credentialId ||
      actual.carrierProtocol !== expected.carrierProtocol ||
      actual.endpointProfileId !== expected.endpointProfileId ||
      actual.catalogCapabilityRevision !== expected.catalogCapabilityRevision ||
      actual.catalogCapabilityDigest !== expected.catalogCapabilityDigest ||
      actual.modelSupport !== expected.modelSupport ||
      actual.capabilitySource !== expected.capabilitySource ||
      actual.routeHealth !== expected.routeHealth ||
      actual.evidenceRevision !== expected.evidenceRevision ||
      actual.evidenceDigest !== expected.evidenceDigest ||
      actual.sourceUrl !== expected.sourceUrl || actual.verifiedAt !== expected.verifiedAt ||
      !sameValue(actual.inputModalities, expected.inputModalities) ||
      !sameValue(actual.acceptedMimeTypes, expected.acceptedMimeTypes) ||
      actual.maxInlineImageBytes !== expected.maxInlineImageBytes ||
      actual.maxWidth !== expected.maxWidth || actual.maxHeight !== expected.maxHeight ||
      actual.maxPixels !== expected.maxPixels ||
      actual.toolServerId !== expected.toolServerId ||
      actual.toolName !== expected.toolName ||
      actual.toolCapabilityDigest !== expected.toolCapabilityDigest) {
    throw new ImageAdmissionError("image_carrier_unverified", "caller_evidence_catalog_mismatch");
  }
}

function assertCatalogImageAdmission(entry: ImageCapabilityCatalogEntry | undefined): asserts entry is ImageCapabilityCatalogEntry {
  if (!entry?.runtime_supported) {
    throw new ImageAdmissionError("image_model_unsupported", "runtime_model_unavailable");
  }
  if (entry.image_input_support === "unsupported") {
    throw new ImageAdmissionError("image_model_unsupported", "catalog_image_support_unsupported");
  }
  if (entry.image_input_support !== "supported") {
    throw new ImageAdmissionError("image_capability_unknown", "catalog_image_support_unknown");
  }
  if (entry.image_route_health === "incompatible") {
    throw new ImageAdmissionError("image_route_incompatible", "exact_route_incompatible");
  }
  if (!entry.image_carrier_protocol && !hostedShapeToCarrier(entry.hosted_api_shape)) {
    throw new ImageAdmissionError("image_carrier_unavailable", "adapter_carrier_missing");
  }
}

export function assertVisualCarrierMatchesCatalog(input: {
  catalogEntry: ImageCapabilityCatalogEntry | undefined;
  tuple: ImageCarrierTuple;
  capability: ImageCapabilityEvidence;
  resolvedRoute: ResolvedImageRoute;
}): { tuple: ImageCarrierTuple; capability: ImageCapabilityEvidence } {
  const entry = input.catalogEntry;
  assertCatalogImageAdmission(entry);
  const tuple = carrierFromCatalog(entry);
  const capability = evidenceFromCatalog(entry, tuple);
  assertTupleEqual(input.tuple, tuple);
  assertEvidenceEqual(input.capability, capability);
  assertTupleEqual(input.resolvedRoute, tuple);
  if (entry.model_ref && entry.model_ref !== `${tuple.providerId}/${tuple.modelId}`) {
    throw new ImageAdmissionError("image_carrier_unverified", "catalog_model_ref_mismatch");
  }
  return { tuple, capability };
}

export function imageAdmissionForCatalogEntry(
  entry: ImageCapabilityCatalogEntry | undefined,
  manifests: readonly VisualAdmittedManifest[],
): VisualImageAdmissionResult {
  assertCatalogImageAdmission(entry);
  const tuple = carrierFromCatalog(entry);
  return admitVisualImageRequest({
    tuple,
    capability: evidenceFromCatalog(entry, tuple),
    manifests,
  });
}

export function admitVisualImageRequest(
  input: VisualImageAdmissionInput,
): VisualImageAdmissionResult {
  const { tuple, capability, manifests } = input;
  if (!tuple.providerId || !tuple.modelId || !tuple.carrierProtocol || !tuple.endpointProfileId ||
      !tuple.catalogCapabilityRevision || !tuple.catalogCapabilityDigest ||
      !capability.providerId || !capability.modelId || !capability.endpointProfileId ||
      !capability.evidenceDigest || !capability.evidenceRevision || !capability.verifiedAt ||
      !capability.modelSupport || !capability.capabilitySource || !capability.routeHealth) {
    throw new ImageAdmissionError("image_carrier_unverified", "tuple_or_evidence_missing");
  }
  if (capability.modelSupport !== "supported") {
    throw new ImageAdmissionError(
      capability.modelSupport === "unsupported"
        ? "image_model_unsupported"
        : "image_capability_unknown",
      "frozen_model_support_invalid",
    );
  }
  if (capability.routeHealth === "incompatible") {
    throw new ImageAdmissionError("image_route_incompatible", "frozen_route_incompatible");
  }
  if (capability.providerId !== tuple.providerId || capability.modelId !== tuple.modelId ||
      capability.carrierProtocol !== tuple.carrierProtocol ||
      capability.endpointProfileId !== tuple.endpointProfileId ||
      capability.catalogCapabilityRevision !== tuple.catalogCapabilityRevision ||
      capability.catalogCapabilityDigest !== tuple.catalogCapabilityDigest ||
      capability.evidenceRevision !== tuple.catalogCapabilityRevision ||
      capability.evidenceDigest !== tuple.catalogCapabilityDigest) {
    throw new ImageAdmissionError("image_carrier_unverified", "tuple_evidence_mismatch");
  }
  if (!capability.inputModalities.some((modality) => modality.toLowerCase() === "image")) {
    throw new ImageAdmissionError("image_model_unsupported", "image_modality_missing");
  }
  if (!Array.isArray(manifests) || manifests.length === 0) {
    throw new ImageAdmissionError("image_manifest_invalid", "manifest_missing");
  }
  const ordered = [...manifests].sort((left, right) => left.position - right.position);
  ordered.forEach((manifest, index) => {
    if (manifest.kind !== "image" || manifest.position !== index || manifest.fileId.length === 0 ||
        manifest.sourceDigest.length !== 64 || manifest.derivativeDigest.length !== 64 ||
        manifest.manifestDigest.length !== 64 || manifest.derivativeSizeBytes <= 0 ||
        manifest.width <= 0 || manifest.height <= 0 || manifest.pixelCount <= 0 ||
        !manifest.storageRevision || !manifest.sniffedMagic || !manifest.sniffedMimeType) {
      throw new ImageAdmissionError("image_manifest_invalid", "manifest_shape_invalid");
    }
    if (!capability.acceptedMimeTypes.map((value) => value.toLowerCase())
      .includes(manifest.derivativeMimeType.toLowerCase())) {
      throw new ImageAdmissionError("image_model_unsupported", "mime_not_admitted");
    }
    if (manifest.derivativeSizeBytes > capability.maxInlineImageBytes ||
        manifest.derivativeSizeBytes > 10 * 1024 * 1024 ||
        manifest.width > capability.maxWidth || manifest.height > capability.maxHeight ||
        manifest.pixelCount > capability.maxPixels) {
      throw new ImageAdmissionError("image_payload_invalid", "image_limit_exceeded");
    }
    freezeVisualManifest(manifest);
  });
  const frozenTuple = Object.freeze({ ...tuple });
  const frozenCapability = Object.freeze({
    ...capability,
    inputModalities: Object.freeze([...capability.inputModalities]),
    acceptedMimeTypes: Object.freeze([...capability.acceptedMimeTypes]),
  });
  const frozenManifests = Object.freeze(ordered);
  return Object.freeze({
    tuple: frozenTuple,
    capability: frozenCapability,
    manifests: frozenManifests,
  });
}

export function createVisualAdmissionMemo(
  factory: () => Promise<VisualImageAdmissionResult>,
): VisualAdmissionMemo {
  let pending: Promise<VisualImageAdmissionResult> | undefined;
  return {
    get(): Promise<VisualImageAdmissionResult> {
      pending ??= factory().then((result) => {
        if (!Object.isFrozen(result)) return Object.freeze(result);
        return result;
      });
      return pending;
    },
  };
}
