/**
 * Public image-admission contracts.  This module intentionally has no app
 * gateway imports: the manifest and carrier tuple are the path-free boundary
 * shared by app persistence, BTCC, and provider adapters.
 */

export type ImageCarrierProtocol =
  | "openai_responses"
  | "openai_chat_completions"
  | "zai_mcp_vision"
  | "fake_vision";

export type ImageInputSupport = "supported" | "unsupported" | "unknown";
export type ImageRouteHealth =
  | "unchecked"
  | "healthy"
  | "incompatible"
  | "transient_failure";
export type ImageCapabilitySource =
  | "provider_catalog"
  | "provider_discovery"
  | "explicit_config"
  | "route_probe"
  | "unknown";

export interface ImageCarrierTuple {
  readonly providerId: string;
  readonly modelId: string;
  readonly carrierProtocol: ImageCarrierProtocol;
  readonly endpointProfileId: string;
  readonly catalogCapabilityRevision: string;
  readonly catalogCapabilityDigest: string;
}

/** Capability evidence is bound to the exact carrier tuple, not just a model family. */
export interface ImageCapabilityEvidence {
  readonly providerId: string;
  readonly modelId: string;
  /** Stable registered credential identity; never a credential secret. */
  readonly credentialId?: string;
  readonly carrierProtocol: ImageCarrierProtocol;
  readonly endpointProfileId: string;
  readonly catalogCapabilityRevision: string;
  readonly catalogCapabilityDigest: string;
  readonly modelSupport: ImageInputSupport;
  readonly capabilitySource: ImageCapabilitySource;
  readonly routeHealth: ImageRouteHealth;
  readonly inputModalities: readonly string[];
  readonly acceptedMimeTypes: readonly string[];
  readonly maxInlineImageBytes: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxPixels: number;
  readonly sourceUrl: string;
  readonly verifiedAt: string;
  readonly evidenceRevision: string;
  readonly evidenceDigest: string;
  /** Present only for tool-assisted carriers; never a filesystem path. */
  readonly toolServerId?: string;
  readonly toolName?: string;
  readonly toolCapabilityDigest?: string;
}

/**
 * The durable, path-free image identity.  `storageRevision` binds the source
 * row that was admitted; `sniffed*` records magic-byte evidence independent of
 * a client-provided MIME string.  Derivative identity is content addressed.
 */
export interface VisualAttachmentManifest {
  readonly kind: "image";
  readonly fileId: string;
  readonly position: number;
  readonly safeName: string;
  readonly mimeType: string;
  readonly sniffedMimeType: string;
  readonly sniffedMagic: "png" | "jpeg" | "gif" | "webp";
  readonly storageRevision: string;
  readonly sourceSizeBytes: number;
  readonly sourceDigest: string;
  readonly manifestDigest: string;
  readonly derivativeId: string;
  readonly derivativeMimeType: string;
  readonly derivativeSizeBytes: number;
  readonly derivativeDigest: string;
  readonly width: number;
  readonly height: number;
  readonly pixelCount: number;
  readonly sanitizerRevision: string;
}

export type VisualAdmittedManifest = VisualAttachmentManifest;

export interface VerifiedImagePayload {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface VerifiedImagePayloadPort {
  read(manifest: VisualAdmittedManifest): Promise<VerifiedImagePayload>;
}

export interface ImageSourceRecord {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageRevision: string;
}

export type VisualSourceRecord = ImageSourceRecord;

export interface ImageSanitizerInput {
  readonly fileId: string;
  readonly safeName: string;
  readonly mimeType: string;
  readonly sourceBytes: Uint8Array;
  readonly storageRevision: string;
  readonly position: number;
  readonly limits?: {
    readonly maxBytes?: number;
    readonly maxWidth?: number;
    readonly maxHeight?: number;
    readonly maxPixels?: number;
  };
}

export interface ImageSanitizedResult {
  readonly manifest: VisualAdmittedManifest;
  readonly bytes: Uint8Array;
}

export interface ImageSanitizerPort {
  sanitize(input: ImageSanitizerInput): Promise<ImageSanitizedResult>;
}

export interface ImageCapabilityCatalogEntry {
  readonly provider_id: string;
  readonly model_id: string;
  readonly model_ref?: string;
  readonly credential_id?: string;
  readonly hosted_api_shape?: string;
  readonly runtime_supported?: boolean;
  readonly image_input_support?: ImageInputSupport;
  readonly image_capability_source?: ImageCapabilitySource;
  readonly image_route_health?: ImageRouteHealth;
  readonly image_input_modalities?: readonly string[];
  readonly image_accepted_mime_types?: readonly string[];
  readonly image_max_inline_bytes?: number;
  readonly image_max_width?: number;
  readonly image_max_height?: number;
  readonly image_max_pixels?: number;
  readonly image_capability_source_url?: string;
  readonly image_capability_verified_at?: string;
  readonly image_capability_revision?: string;
  readonly image_capability_digest?: string;
  readonly image_endpoint_profile_id?: string;
  readonly image_carrier_protocol?: ImageCarrierProtocol;
  readonly image_tool_server_id?: string;
  readonly image_tool_name?: string;
  readonly image_tool_capability_digest?: string;
}

export interface VisualCapabilityResolverInput {
  readonly entry: ImageCapabilityCatalogEntry | undefined;
  readonly modelRef: string;
  readonly butlerData: string;
  readonly signal?: AbortSignal;
}

export interface VisualCapabilityResolver {
  resolve(
    input: VisualCapabilityResolverInput,
  ): Promise<ImageCapabilityCatalogEntry | undefined>;
}

export interface ResolvedImageRoute {
  readonly providerId: string;
  readonly modelId: string;
  readonly carrierProtocol: ImageCarrierProtocol;
  readonly endpointProfileId: string;
  readonly catalogCapabilityRevision: string;
  readonly catalogCapabilityDigest: string;
}

export interface VisualImageAdmissionInput {
  readonly tuple: ImageCarrierTuple;
  readonly capability: ImageCapabilityEvidence;
  readonly manifests: readonly VisualAdmittedManifest[];
}

export interface VisualImageAdmissionResult {
  readonly tuple: ImageCarrierTuple;
  readonly capability: ImageCapabilityEvidence;
  readonly manifests: readonly VisualAdmittedManifest[];
}

export interface VisualAdmissionMemo {
  get(): Promise<VisualImageAdmissionResult>;
}

export class ImageAdmissionError extends Error {
  readonly code:
    | "image_model_unsupported"
    | "image_capability_unknown"
    | "image_carrier_unavailable"
    | "image_route_incompatible"
    | "image_carrier_unverified"
    | "image_manifest_invalid"
    | "image_payload_invalid";

  constructor(
    code: ImageAdmissionError["code"],
    message: string = code,
  ) {
    super(`${code}:${message}`);
    this.name = "ImageAdmissionError";
    this.code = code;
  }
}
