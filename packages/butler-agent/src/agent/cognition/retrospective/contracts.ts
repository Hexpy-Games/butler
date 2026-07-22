import type { ModelPhaseState } from "../../btcc/core/index.ts";
import type { AcceptedPhaseGuidance } from "../../btcc/guidance/index.ts";
import type { PromptUsageReport } from "../../../integrations/providers/provider.ts";
import type { ConsolidationModelUsageSummary } from "../consolidation/usage.ts";

export const RETROSPECTIVE_DIMENSIONS = [
  "goal_fidelity",
  "conception_quality",
  "planning_quality",
  "ledger_fitness",
  "execution_fidelity",
  "review_effectiveness",
  "efficiency_and_proportionality",
  "user_stewardship",
  "learning_calibration",
] as const;

export type RetrospectiveDimension = typeof RETROSPECTIVE_DIMENSIONS[number];

export type BtccTrajectory = {
  sourceId: string;
  outboxId: string;
  turnId: string;
  userRef: string;
  projectRef?: string;
  originalRequest: string;
  goalContract?: unknown;
  phaseProducts: Array<{
    semanticState: string;
    turnRevision: number;
    acceptedProduct: unknown;
  }>;
  finalDossier?: unknown;
  finalPayload: unknown;
  recentFeedback: Array<{ ref: string; content: string }>;
};

export type RetrospectiveFinding = {
  score: number;
  assessment: string;
  sourceRefs: string[];
};

export type PhaseGuidanceCandidate = {
  candidateId: string;
  phase: ModelPhaseState;
  scopeKind: "user" | "project";
  problem: string;
  guidance: string;
  appliesWhen: string[];
  doesNotApplyWhen: string[];
  expectedBenefit: string;
  risks: string[];
  confidence: number;
  sourceRefs: string[];
};

export type BtccRetrospective = {
  sourceId: string;
  summary: string;
  dimensions: Record<RetrospectiveDimension, RetrospectiveFinding>;
  strengths: string[];
  misses: string[];
  candidates: PhaseGuidanceCandidate[];
  outsideLearningSurface: Array<{
    finding: string;
    requiredChange: string;
    sourceRefs: string[];
  }>;
};

export type GuidanceDisposition =
  | "promote"
  | "merge"
  | "supersede"
  | "defer"
  | "reject"
  | "outside_learning_surface";

export type GuidanceDecision = {
  candidateId: string;
  disposition: GuidanceDisposition;
  guidanceId: string;
  rationale: string;
};

export type RetrospectiveDecisionSet = {
  sourceId: string;
  decisions: GuidanceDecision[];
};

export type RetrospectiveModelRunnerInput = {
  kind: "evaluate" | "consolidate";
  instructions: string;
  prompt: string;
  cacheScope: string;
  butlerData: string;
};

export type RetrospectiveModelRunnerResult = {
  text: string;
  usage?: PromptUsageReport | null;
};

export type RetrospectiveModelRunner = (
  input: RetrospectiveModelRunnerInput,
) => Promise<string | RetrospectiveModelRunnerResult>;

export interface BtccRetrospectiveStore {
  loadPendingTrajectories(limit?: number): BtccTrajectory[];
  loadRetrospective(sourceId: string): BtccRetrospective | null;
  saveRetrospective(value: BtccRetrospective): void;
  loadDecisions(sourceId: string): RetrospectiveDecisionSet | null;
  saveDecisions(value: RetrospectiveDecisionSet): void;
  loadAcceptedGuidance(trajectory: BtccTrajectory, phases: ModelPhaseState[]): AcceptedPhaseGuidance[];
  publishGuidance(input: Omit<AcceptedPhaseGuidance, "revision" | "contentSha256">): AcceptedPhaseGuidance;
  markProcessed(outboxId: string): void;
  recordFailure(outboxId: string, error: string): void;
  close(): void;
}

export type BtccRetrospectiveMetrics = {
  pending_count: number;
  processed_count: number;
  failed_count: number;
  promoted_guidance_count: number;
  model_usage: ConsolidationModelUsageSummary;
  raw_text_included: false;
};
