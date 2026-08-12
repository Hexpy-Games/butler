export { runAgentBenchmarkCli } from "./cli.ts";
export { AGENT_BENCHMARK_BASELINE_SHA, AGENT_BENCHMARK_SCHEMA, VISUAL_REVIEW_SCHEMA } from "./contracts.ts";
export { benchmarkPlanIdentity, createBenchmarkPlan, seededShuffle, summarizePlan } from "./planning.ts";
export {
  AGENT_BENCHMARK_FIXTURES,
  getBenchmarkFixture,
  hashBenchmarkFixture,
  materializeFixturePrompt,
  loadM1V2BenchmarkFixtures,
  verifyM1V2AuthoritativeProvenance,
} from "./fixtures.ts";
export { generateBenchmarkReport, summarizeBenchmarkResult, writeBenchmarkReport } from "./report.ts";
export { runAgentBenchmark, createFileCheckpointStore } from "./workflow.ts";
export {
  corroborateExecution, createPairedCampaignContract,
  readProviderAuthPreflight, replacementEligibility, requireAvailableProviderAuth,
  validatePairedCampaignContract,
} from "./paired-contract.ts";
export type {
  BenchmarkVersion, PairedCampaignContract, PairedSourcePin, ProviderAuthPreflight,
} from "./paired-contract.ts";
export {
  aggregatePairedMetrics, comparisonIndexHtml, createComparisonIndex,
  landingQualityPassed, pairEligibility, summarizePairedBenchmarkResult,
} from "./paired-evaluation.ts";
export type { ComparisonIndexEntry, PairedMetricRow } from "./paired-evaluation.ts";
export { deriveAcceptedResultPerToken, evaluateAdapterResult, evaluateWebResearch } from "./evaluators.ts";
export { applyVisualReviews, readVisualReviewFile } from "./visual-review.ts";
export type {
  AgentAdapter,
  BenchmarkAgent,
  BenchmarkCampaign,
  BenchmarkArmPlan,
  BenchmarkCacheState,
  BenchmarkFixture,
  BenchmarkObservation,
  BenchmarkPlan,
  BenchmarkResultFile,
  BenchmarkScenario,
  BenchmarkTerminalState,
  BenchmarkTrack,
  EffectiveAgentConfig,
  VisualReviewEvidence,
  VisualReviewFile,
} from "./contracts.ts";
