export const M1_REQUEST_SEGMENT_KINDS = [
  "stable_safety_and_role_instructions", "stable_btcc_protocol", "current_user_request",
  "accepted_corrections_and_unresolved_obligations", "project_ledger_and_work_authority",
  "memory_recall_context", "phase_continuity", "tool_schema", "latest_tool_result_delivery",
  "older_tool_result_projection", "exact_result_view", "work_recovery_receipt",
  "source_reference", "provider_carrier_overhead", "other_typed_context",
] as const;
export type M1RequestSegmentKind = typeof M1_REQUEST_SEGMENT_KINDS[number];
export type M1SegmentStability = "stable" | "dynamic";
export type M1AttemptEligibility = "eligible" | "retry_contaminated" | "cache_mismatch" |
  "usage_unavailable" | "rejected";
export interface M1RequestSegmentSource {
  kind: M1RequestSegmentKind; stability: M1SegmentStability; text: string;
}
export interface M1ProviderRequestSegmentManifestEntry {
  path: readonly (string | number)[];
  kind: M1RequestSegmentKind;
  stability: M1SegmentStability;
  startUtf16?: number;
  endUtf16?: number;
}
export interface M1CacheBoundaryEvidence {
  expectedRevision: string;
  observedRevision: string;
}
export interface M1RequestEnvelopeObservation {
  schemaVersion: "butler.m1-request-envelope.v2"; attemptDigest: string; turnDigest: string;
  phaseDigest: string; roundIndex: number; retryOrdinal: number; providerId: string;
  modelRef: string; armId: string | null; sourceRevision: string | null;
  cacheBoundaryRevision: string; providerSendBytes: number; estimatedInputTokens: number | null;
  eligibility: M1AttemptEligibility;
}
export interface M1RequestSegmentObservation {
  schemaVersion: "butler.m1-request-segment.v2"; attemptDigest: string; segmentId: string;
  kind: M1RequestSegmentKind; stability: M1SegmentStability; providerSendBytes: number;
  estimatedInputTokens: number | null; keyedContentDigest: string;
}
export interface M1ResponseUsageObservation {
  schemaVersion: "butler.m1-response-usage.v2"; attemptDigest: string;
  status: "usage_bearing" | "unavailable"; promptTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null; outputTokens: number | null;
  reasoningTokens: number | null; totalTokens: number | null;
}
export interface M1ProviderAttemptObservation {
  envelope: M1RequestEnvelopeObservation; segments: M1RequestSegmentObservation[];
}
