import type { ElectronHarnessOptions, ElectronScenario } from
  "../../e2e/btcc-r3-electron-harness.ts";
import type { OperationalMetricEvent } from
  "../../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import type { M1RequestSegmentKind } from
  "../../../packages/butler-agent/src/agent/btcc/ports/provider-request-attribution.ts";

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
  scenario: ElectronScenario;
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
  lostCorrectionEvidenceCount: null;
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
  schema: "butler.m1-v2-baseline-campaign.v1";
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
    lostCorrectionEvidenceCount: null;
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
}

export interface M1V2CampaignConfig {
  outputRoot: string;
  sourceData: string;
  repoRoot: string;
  repetitions: number;
  sourceRevision?: string;
  browserExecutablePath?: string;
}

export interface M1V2CampaignDependencies {
  runHarness?: (
    scenario: ElectronScenario,
    options: ElectronHarnessOptions,
  ) => Promise<Record<string, unknown>>;
  readMetrics?: (butlerData: string) => OperationalMetricEvent[];
  assess?: (input: M1V2AssessmentInput) => M1V2RepetitionResult;
  readDb?: (butlerData: string, turnId: string) => M1V2DbEvidence;
  validateLanding?: (input: {
    browserExecutablePath?: string;
    runRoot: string;
    workspaceRoot: string;
  }) => Promise<M1V2LandingValidation | null>;
}
