export const BTCC_REVISION_BENCHMARK_SCHEMA =
  "butler.btcc-revision-benchmark.v3" as const;

export type BtccRevision = "r2" | "r3";
export type BenchmarkTier = "direct" | "simple_tool" | "work_ledger" | "project_ledger";
export type BenchmarkLedgerRoute = "none" | "work" | "project";

export interface BenchmarkPromptCase {
  id: string;
  tier: BenchmarkTier;
  promptTemplate: string;
  requiredOutcomes: string[];
  expectedLedgerRoute: BenchmarkLedgerRoute;
  timeoutMs: number;
}

export interface MaterializedBenchmarkPrompt extends Omit<BenchmarkPromptCase, "promptTemplate"> {
  prompt: string;
  order: readonly [BtccRevision, BtccRevision];
}

export interface BenchmarkTarget {
  revision: BtccRevision;
  worktreePath: string;
  commit: string;
  buildId: string;
  appBaseUrl: string;
  electronDebugPort: number;
  dataRoot: string;
  electronUserData: string;
  workspaceRoot: string;
  model: string;
  reasoningEffort: string;
  permissionMode: string;
  fixtureHash: string;
}

export interface BenchmarkPlan {
  schema: typeof BTCC_REVISION_BENCHMARK_SCHEMA;
  kind: "paired_e2e_plan";
  runId: string;
  createdAt: string;
  targets: Record<BtccRevision, BenchmarkTarget>;
  prompts: MaterializedBenchmarkPrompt[];
}

export type BenchmarkTerminalState =
  | "delivered"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface RawBenchmarkObservation {
  schema: typeof BTCC_REVISION_BENCHMARK_SCHEMA;
  kind: "raw_product_observation";
  runId: string;
  promptId: string;
  revision: BtccRevision;
  prompt: string;
  target: BenchmarkTarget;
  turnId: string;
  terminalState: BenchmarkTerminalState;
  finalText: string;
  providerReportedModel: string | null;
  quality: {
    intentScore: number | null;
    resultScore: number | null;
    requiredOutcomes: Record<string, boolean>;
    assessmentNote: string | null;
  };
  usage: {
    modelRequests: number | null;
    promptTokens: number | null;
    cachedPromptTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    serializedContextBytes: number | null;
  };
  timing: {
    submittedAtMs: number | null;
    acknowledgedAtMs: number | null;
    admittedAtMs: number | null;
    modelRequestStartedAtMs: number | null;
    firstProviderTokenAtMs: number | null;
    firstMeaningfulAtMs: number | null;
    finalVisibleAtMs: number | null;
    terminalAtMs: number | null;
    maxSilentGapMs: number | null;
  };
  ux: {
    progressMessages: string[];
    protocolJargonMessages: number | null;
    userInterventions: number | null;
  };
  loop: {
    noProgressTurns: number | null;
    validatorRejections: number | null;
  };
  tools: {
    calls: number | null;
    failedCalls: number | null;
    recoveredErrors: number | null;
    recoveryTimeMs: number | null;
  };
  durability: {
    finalMessagesBeforeReload: number | null;
    finalMessagesAfterReload: number | null;
    eventReplayParity: boolean | null;
    continuationTested: boolean;
    continuationSucceeded: boolean | null;
  };
  safety: {
    unauthorizedEffects: number | null;
    targetEscapes: number | null;
    falseSuccessClaims: number | null;
    privacyLeaks: number | null;
  };
  artifactRefs: string[];
}

export interface BenchmarkEvidenceFile {
  schema: typeof BTCC_REVISION_BENCHMARK_SCHEMA;
  kind: "paired_e2e_evidence";
  plan: BenchmarkPlan;
  observations: RawBenchmarkObservation[];
}

export interface ObservationMetrics {
  measurementComplete: boolean;
  outcomeSuccess: boolean;
  qualityScore: number | null;
  totalTokens: number | null;
  serializedContextBytes: number | null;
  acknowledgementMs: number | null;
  contextPreparationMs: number | null;
  providerFirstTokenMs: number | null;
  firstMeaningfulMs: number | null;
  finalVisibleMs: number | null;
  productWallMs: number | null;
  maxSilentGapMs: number | null;
  unrecoveredToolErrors: number | null;
  durabilityPass: boolean | null;
  safetyPass: boolean | null;
  noProgressTurns: number | null;
  validatorRejections: number | null;
}

export interface BenchmarkPairComparison {
  promptId: string;
  tier: BenchmarkTier;
  r2: ObservationMetrics | null;
  r3: ObservationMetrics | null;
  qualityDelta: number | null;
  totalTokenRatio: number | null;
  contextPreparationRatio: number | null;
  firstMeaningfulRatio: number | null;
  winner: BtccRevision | "tie" | "undecided";
  reasons: string[];
}

export interface BenchmarkTierSummary {
  tier: BenchmarkTier;
  pairs: number;
  r2Wins: number;
  r3Wins: number;
  ties: number;
  meanQualityDelta: number | null;
  meanTotalTokenRatio: number | null;
  meanContextPreparationRatio: number | null;
  meanFirstMeaningfulRatio: number | null;
}

export interface BenchmarkReport {
  schema: typeof BTCC_REVISION_BENCHMARK_SCHEMA;
  kind: "paired_e2e_report";
  runId: string;
  verdict: "r3_better" | "r2_better" | "no_clear_winner" | "insufficient_evidence";
  reasons: string[];
  expectedObservations: number;
  observedObservations: number;
  pairs: BenchmarkPairComparison[];
  tiers: BenchmarkTierSummary[];
}
