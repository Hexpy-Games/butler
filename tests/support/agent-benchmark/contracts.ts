/** Public contract for the Butler agent benchmark domain.
 *
 * This file deliberately contains data only.  Adapters and workflow code are
 * kept in separate modules so that the report cannot become a second source of
 * truth for run state.
 */

export const AGENT_BENCHMARK_SCHEMA = "butler.agent-benchmark.v1" as const;
export const AGENT_BENCHMARK_BASELINE_SHA =
  "549463fbe074fc25042f9302cd330699948dab50" as const;
export const VISUAL_REVIEW_SCHEMA = "butler.agent-benchmark.visual-review.v1" as const;

export type BenchmarkCampaign = "cross-agent-pilot" | "m1-v2";

export type BenchmarkAgent = "butler" | "hermes" | "opencode";
export type BenchmarkTrack = "controlled" | "recommended-default";
export type BenchmarkCacheState = "cold" | "warm";
export type BenchmarkTerminalState =
  | "accepted"
  | "rejected"
  | "failed"
  | "timed_out"
  | "gated";
export type BenchmarkGateCode =
  | "none"
  | "executable_missing"
  | "authentication_unavailable"
  | "configuration_unverifiable"
  | "measurement_unavailable";
export type BenchmarkScenario =
  | "direct_conversation"
  | "current_web_research"
  | "butler_landing_page"
  | "direct-cold"
  | "direct-warm"
  | "current-web-cold"
  | "landing-cold";

export interface EffectiveAgentConfig {
  model: string | null;
  reasoning: string | null;
  permissions: string;
  tools: readonly string[];
  memoryEnabled: boolean | null;
  skillsEnabled: boolean | null;
  pluginsEnabled: boolean | null;
  mcpEnabled: boolean | null;
  provider: string | null;
  variant: string | null;
}

export interface BenchmarkFixtureSummary {
  id: BenchmarkScenario;
  version: string;
  frozenEvaluationDate?: string;
  sha256: string;
  promptCount: number;
}

export interface BenchmarkArmPlan {
  key: string;
  scenario: BenchmarkScenario;
  repetition: number;
  order: number;
  agent: BenchmarkAgent;
  track: BenchmarkTrack;
  cache: BenchmarkCacheState;
  fixtureHash: string;
  effectiveConfig: EffectiveAgentConfig;
  sourceRoot: string;
  outputRoot: string;
  dataRoot: string;
  evidenceRoot: string;
  cacheRoot: string;
  cachePairId: string;
  timeoutMs: number;
  sourceRevision: string;
}

export interface BenchmarkPlan {
  schema: typeof AGENT_BENCHMARK_SCHEMA;
  kind: "agent_benchmark_plan";
  campaign: BenchmarkCampaign;
  runId: string;
  createdAt: string;
  seed: number;
  baselineSha: string;
  runRoot: string;
  sourceRoot: string;
  tracks: readonly BenchmarkTrack[];
  fixtures: readonly BenchmarkFixtureSummary[];
  repositoryEvidence?: { relativeRoot: string; files: readonly string[]; sha256: string };
  policy?: {
    sequential: true;
    observerOnly: true;
    retryContaminatedAccepted: false;
    replacementRunsAllowed: false;
    directWarmSameSession: true;
    expectedObservedCacheBoundaryMustMatch: true;
    rubricVersion: string;
  };
  arms: readonly BenchmarkArmPlan[];
}

export interface PreflightResult {
  available: boolean;
  executable: string | null;
  version: string | null;
  authenticated: boolean | null;
  configVerified: boolean;
  gateCode: BenchmarkGateCode;
  diagnostic: string | null;
  effectiveConfig?: Partial<EffectiveAgentConfig>;
}

export interface TokenUsage {
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  modelRequests: number | null;
}

export interface ToolCallObservation {
  callId?: string | null;
  name: string | null;
  status: "completed" | "failed" | "unknown";
  startedAtMs: number | null;
  endedAtMs: number | null;
}

export interface ToolMetrics {
  calls: number | null;
  failedCalls: number | null;
  records: readonly ToolCallObservation[];
}

export interface TimingMetrics {
  submittedAtMs: number | null;
  firstUsefulOutputAtMs: number | null;
  terminalAtMs: number | null;
  totalElapsedMs: number | null;
}

export interface OperationMetrics {
  userInterventions: number | null;
  retries: number | null;
  changedFiles: number | null;
  tests: {
    ran: boolean | null;
    passed: boolean | null;
    command: string | null;
  };
  build: {
    ran: boolean | null;
    passed: boolean | null;
    command: string | null;
  };
}

export interface EvaluationMetrics {
  accepted: boolean | null;
  factualAccuracy: number | null;
  sourceQuality: number | null;
  visualQuality: number | null;
  resultQuality: number | null;
  evaluatorNotes: readonly string[];
  evidenceRefs: readonly string[];
}

export interface PrivacyMetrics {
  redacted: boolean;
  promptLeak: boolean;
  credentialLeak: boolean;
  rawToolPayloadLeak: boolean;
  privatePathLeak: boolean;
  hiddenReasoningLeak: boolean;
}

export interface VisualReviewEvidence {
  score: number;
  reviewerLabel: string;
  rubricVersion: string;
}

export interface VisualReviewFile {
  schema: typeof VISUAL_REVIEW_SCHEMA;
  reviews: readonly (VisualReviewEvidence & { armKey: string })[];
}

export interface BenchmarkObservation {
  schema: typeof AGENT_BENCHMARK_SCHEMA;
  kind: "agent_benchmark_observation";
  arm: BenchmarkArmPlan;
  terminalState: BenchmarkTerminalState;
  gateCode: BenchmarkGateCode;
  adapterVersion: string | null;
  effectiveConfig: EffectiveAgentConfig;
  usage: TokenUsage;
  tools: ToolMetrics;
  timing: TimingMetrics;
  operations: OperationMetrics;
  evaluation: EvaluationMetrics;
  visualReview: VisualReviewEvidence | null;
  privacy: PrivacyMetrics;
  acceptedResultPerToken: number | null;
  promptHash: string | null;
  answerHash: string | null;
  changedPaths: readonly string[];
  diagnostics: readonly string[];
  evidenceRefs: readonly string[];
  m1V2?: import("./m1-v2-types.ts").M1V2RepetitionResult | null;
}

export interface BenchmarkResultFile {
  schema: typeof AGENT_BENCHMARK_SCHEMA;
  kind: "agent_benchmark_result";
  run: Pick<BenchmarkPlan, "runId" | "seed" | "baselineSha" | "runRoot"> & {
    state: "planned" | "preflight" | "running" | "reported";
    /** Stable plan/config/fixture identity used for idempotent resume. */
    planIdentity?: string;
  };
  plan: BenchmarkPlan;
  observations: BenchmarkObservation[];
}

export interface BenchmarkFixture {
  id: BenchmarkScenario;
  version: string;
  frozenEvaluationDate?: string;
  prompts: readonly string[];
  expectedFiles?: readonly string[];
  expectedClaims?: readonly string[];
  expectedSources?: readonly string[];
  authoritativeSourceClasses?: readonly string[];
  requiredBuildCommand?: readonly string[];
  requiredTestCommand?: readonly string[];
  viewportSizes?: readonly { width: number; height: number }[];
  m1V2?: import("./m1-v2-types.ts").CanonicalM1V2Fixture;
}

export interface AdapterRunInput {
  arm: BenchmarkArmPlan;
  fixture: BenchmarkFixture;
  prompt: string;
  sessionId: string | null;
  sourceEvidenceRoot: string;
  runtimeInstructions: string;
  signal: AbortSignal;
}

export interface AdapterRunResult {
  exitCode: number | null;
  gateCode: BenchmarkGateCode;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  adapterVersion: string | null;
  provider: string | null;
  finalText: string | null;
  sessionId: string | null;
  effectiveConfig?: Partial<EffectiveAgentConfig>;
  usage: Partial<TokenUsage>;
  tools: Partial<ToolMetrics>;
  timing: Partial<TimingMetrics>;
  operations: Partial<OperationMetrics>;
  landingValidation?: LandingValidation;
  changedPaths: readonly string[];
  evidenceRefs: readonly string[];
  m1V2Evidence?: {
    evidence: Record<string, unknown>;
    metrics: import("../../../packages/butler-agent/src/operations/metrics/operational-metrics.ts").OperationalMetricEvent[];
    db: import("./m1-v2-types.ts").M1V2DbEvidence | null;
    landingValidation: import("./m1-v2-types.ts").M1V2LandingValidation | null;
    sourceRevision: string;
    attemptStartedAtMs: number;
  };
}

export interface LandingValidation {
  buildPassed: boolean | null;
  testPassed: boolean | null;
  browserAvailable: boolean;
  desktop: { loaded: boolean; overflowFree: boolean; screenshotRef: string | null };
  mobile: { loaded: boolean; overflowFree: boolean; screenshotRef: string | null };
  visualQuality: number | null;
  diagnostics: readonly string[];
}

export interface AgentAdapter {
  readonly agent: BenchmarkAgent;
  preflight(): Promise<PreflightResult>;
  run(input: AdapterRunInput): Promise<AdapterRunResult>;
}
