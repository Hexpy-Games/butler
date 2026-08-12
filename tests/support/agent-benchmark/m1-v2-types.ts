import type { ElectronScenario } from
  "../../e2e/btcc-r3-electron-harness.ts";
import type { OperationalMetricEvent } from
  "../../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
export const OBSERVED_M1_REQUEST_SEGMENT_KINDS = [
  "stable_safety_and_role_instructions", "stable_btcc_protocol",
  "current_user_request", "accepted_corrections_and_unresolved_obligations",
  "project_ledger_and_work_authority", "memory_recall_context", "phase_continuity",
  "tool_schema", "latest_tool_result_delivery", "older_tool_result_projection",
  "exact_result_view", "work_recovery_receipt", "source_reference",
  "provider_carrier_overhead", "other_typed_context",
] as const;
export type M1RequestSegmentKind = typeof OBSERVED_M1_REQUEST_SEGMENT_KINDS[number];
export const POTENTIALLY_REDUCIBLE_M1_SEGMENTS = new Set<M1RequestSegmentKind>([
  "stable_btcc_protocol",
  "accepted_corrections_and_unresolved_obligations",
  "project_ledger_and_work_authority",
  "memory_recall_context",
  "phase_continuity",
  "tool_schema",
  "latest_tool_result_delivery",
  "older_tool_result_projection",
  "exact_result_view",
  "work_recovery_receipt",
  "other_typed_context",
]);

export const M1_V2_ARM_IDS = [
  "direct-cold",
  "direct-warm",
  "current-web-cold",
  "landing-cold",
] as const;
export type M1V2ArmId = typeof M1_V2_ARM_IDS[number];
export type M1V2RepetitionStatus = "accepted" | "rejected" | "gated";

export interface CanonicalM1V2Fixture {
  armId: M1V2ArmId;
  scenario: ElectronScenario & {
    attributionArmId: M1V2ArmId;
    cacheBoundaryEvidence?: {
      expectedRevision: string;
      observedRevision: string;
    };
  };
  targetStepId: string;
  publicBenchmarkFixture: true;
  promptSha256: Record<string, string>;
  fixtureSha256: Record<string, string>;
}

export interface M1V2AttemptSummary {
  exactByteSum: boolean;
  providerSendBytes: number;
  segmentSendBytes: number;
  retryOrdinal: number;
  eligibility: string;
  responseUsageStatus: "unavailable" | "usage_bearing";
  promptTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  otherShare: number;
  segments: Partial<Record<M1RequestSegmentKind, number>>;
}

export interface M1V2DbEvidence {
  quickCheckDatabases: number;
  quickCheckPassed: boolean;
  toolCalls: number;
  webToolCalls: number;
  pagePreviewToolCalls: number;
  buildCommandToolCalls: number;
  fileMutationToolCalls: number;
  duplicateAppliedEffects: number | null;
  unresolvedCorrections: number | null;
  lostRequiredAnchors: number | null;
}

export interface M1V2LandingValidation {
  buildPassed: boolean;
  desktopPassed: boolean;
  mobilePassed: boolean;
  desktopScreenshotPresent: boolean;
  mobileScreenshotPresent: boolean;
  indexChanged: boolean;
  stylesChanged: boolean;
  butlerGrounded: boolean;
  featureBlockCount: number;
  usageScenePresent: boolean;
  ctaPresent: boolean;
  responsiveCssPresent: boolean;
  durableProjectWorkGrounded: boolean;
  memoryContextGrounded: boolean;
  toolsWorkspaceGrounded: boolean;
  providerRoutingGrounded: boolean;
  recoveryGrounded: boolean;
  genericCopyAbsent: boolean;
  approvedCapabilityClaims: M1V2ApprovedCapabilityClaim[];
}

export type M1V2ApprovedCapabilityClaimId =
  | "butler.durable_project_work.v1"
  | "butler.memory_context.v1"
  | "butler.tools_workspace_authority.v1"
  | "butler.provider_routing.v1"
  | "butler.recovery.v1";

export interface M1V2ApprovedCapabilityClaim {
  id: M1V2ApprovedCapabilityClaimId;
  requiredElementsPresent: boolean[];
  negated: boolean;
  misrepresented: boolean;
  passed: boolean;
}

export interface M1V2QualitySummary {
  conciseGreeting: boolean | null;
  fixedDatePresent: boolean | null;
  umbrellaRecommendationPresent: boolean | null;
  sourceReferenceCount: number | null;
  sourceGrounded: boolean | null;
  landing: M1V2LandingValidation | null;
}

export interface M1V2WorkEvidence {
  observed: boolean;
  status: string | null;
  planRevision: number | null;
  checkpointStage: string | null;
  checkpointStages: number;
  planReviewVerdict: string | null;
  resultReviewVerdict: string | null;
  completionValidationVerdict: string | null;
  resultToolNames: number;
  projectLedgerWorkRecords: number;
  projectLedgerCompletedWorkRecords: number;
  projectLedgerCloseoutObserved: boolean;
  duplicateEvidenceCount: number | null;
  lostCorrectionEvidenceCount: number | null;
  lostRequiredAnchorCount: number | null;
  workspaceAuthorityPassed: boolean | null;
  providerRoutingPassed: boolean | null;
  stallObserved: boolean | null;
}

export interface M1V2PhysicalOverheadSummary {
  attempts: number;
  providerSendBytes: number;
}

export interface M1V2RepetitionResult {
  armId: M1V2ArmId;
  repetition: number;
  status: M1V2RepetitionStatus;
  reasons: string[];
  targetTerminalState: string | null;
  agentAttempts: M1V2AttemptSummary[];
  auxiliaryPhysicalAttempts: number;
  titlePhysicalAttempts: number;
  providerToolPhysicalAttempts: number;
  unarmedPhysicalOverhead: {
    auxiliary: M1V2PhysicalOverheadSummary;
    title: M1V2PhysicalOverheadSummary;
    toolProvider: M1V2PhysicalOverheadSummary;
  };
  otherShare: number | null;
  reducibleShare: number | null;
  semanticRounds: number;
  toolCalls: number;
  elapsedMs: number | null;
  firstUsefulMs: number | null;
  reloadPassed: boolean;
  quality: M1V2QualitySummary;
  db: M1V2DbEvidence | null;
  work: M1V2WorkEvidence;
}

export interface M1V2CampaignResult {
  schema: "butler.agent-benchmark.m1-v2.v1";
  model: "openai/gpt-5.6-sol";
  reasoningEffort: "medium";
  sequential: true;
  repetitionsPerArm: number;
  complete: boolean;
  counts: Record<M1V2RepetitionStatus, number>;
  repetitions: M1V2RepetitionResult[];
  arms: M1V2ArmAggregate[];
  privacy: {
    rawPromptStored: false;
    rawFinalStored: false;
    rawToolPayloadStored: false;
    urlOrQueryStored: false;
    privatePathStored: false;
    credentialStored: false;
    generatedContentHashStored: false;
  };
}

export interface M1V2ArmAggregate {
  armId: M1V2ArmId;
  accepted: number;
  rejected: number;
  gated: number;
  providerSendBytes: { median: number | null; min: number | null; max: number | null };
  reducibleShare: { median: number | null; min: number | null; max: number | null };
  semanticRounds: { median: number | null; min: number | null; max: number | null };
  toolCalls: { median: number | null; min: number | null; max: number | null };
  elapsedMs: { median: number | null; min: number | null; max: number | null };
  firstUsefulMs: { median: number | null; min: number | null; max: number | null };
  responseUsage: Record<
    "promptTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens" |
      "reasoningTokens" | "totalTokens",
    M1V2NullableRange
  >;
  retry: {
    physicalAttempts: number;
    contaminatedAttempts: number;
    rate: number | null;
    providerSendBytes: number;
    bytesPerRepetition: { median: number | null; min: number | null; max: number | null };
  };
  unarmedPhysicalOverhead: Record<
    "auxiliary" | "title" | "toolProvider",
    {
      attempts: number;
      providerSendBytes: number;
      bytesPerRepetition: { median: number | null; min: number | null; max: number | null };
    }
  >;
  work: {
    observedAcceptedRepetitions: number;
    completedAcceptedRepetitions: number;
    acceptedPlanReviews: number;
    acceptedResultReviews: number;
    acceptedCompletionValidations: number;
    projectLedgerCloseouts: number;
    duplicateEvidenceCount: number | null;
    lostCorrectionEvidenceCount: number | null;
    lostRequiredAnchorCount: number | null;
    workspaceAuthorityFailures: number | null;
    providerRoutingFailures: number | null;
    stalledRepetitions: number | null;
  };
  segmentProviderSendBytes: Partial<Record<
    M1RequestSegmentKind,
    { median: number | null; min: number | null; max: number | null }
  >>;
}

export interface M1V2NullableRange {
  available: number;
  unavailable: number;
  median: number | null;
  min: number | null;
  max: number | null;
}

export interface M1V2AssessmentInput {
  armId: M1V2ArmId;
  repetition?: number;
  targetStepId: string;
  evidence: Record<string, unknown>;
  metrics: OperationalMetricEvent[];
  db?: M1V2DbEvidence | null;
  landingValidation?: M1V2LandingValidation | null;
  sourceRevision?: string;
}
