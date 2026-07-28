import type { ModelPhaseState } from "../../btcc/core/index.ts";
import type {
  AcceptedPhaseGuidance,
  PhaseGuidanceRevisionRef,
  PublishPhaseGuidanceCommand,
} from "../../btcc/guidance/index.ts";
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
export const GUIDANCE_DECISION_CONTRACT_REVISION = "btcc.guidance-decision.v1" as const;

export type GuidanceScopeKind = "user" | "project" | "session" | "global";
export type GuidanceGeneralityBoundary =
  | "cross_project_user_preference"
  | "project_bound_strategy"
  | "session_bound_strategy"
  | "global_phase_practice";

export type RetrospectiveDimension = typeof RETROSPECTIVE_DIMENSIONS[number];

export type BtccTrajectory = {
  sourceId: string;
  outboxId: string;
  turnId: string;
  sessionId: string;
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
  scopeKind: GuidanceScopeKind;
  scopeRationale: string;
  scopeSourceRefs: string[];
  generalityBoundary: GuidanceGeneralityBoundary;
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
  rubricRevision: "btcc.retrospective-rubric.v1";
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

type GuidanceDecisionBase = {
  candidateId: string;
  guidanceId: string;
  rationale: string;
};

export type GuidanceDecision = GuidanceDecisionBase & (
  | {
      disposition: "promote";
      acceptedScopeKind: GuidanceScopeKind;
      acceptedScopeRationale: string;
      acceptedScopeSourceRefs: string[];
      acceptedGeneralityBoundary: GuidanceGeneralityBoundary;
      acceptedGuidance: string;
      acceptedAppliesWhen: string[];
      acceptedDoesNotApplyWhen: string[];
    }
  | {
      disposition: "merge" | "supersede";
      targetRevision: PhaseGuidanceRevisionRef;
      acceptedScopeKind: GuidanceScopeKind;
      acceptedScopeRationale: string;
      acceptedScopeSourceRefs: string[];
      acceptedGeneralityBoundary: GuidanceGeneralityBoundary;
      acceptedGuidance: string;
      acceptedAppliesWhen: string[];
      acceptedDoesNotApplyWhen: string[];
    }
  | { disposition: "defer" | "reject" | "outside_learning_surface" }
);

export type RetrospectiveDecisionSet = {
  sourceId: string;
  contractRevision: typeof GUIDANCE_DECISION_CONTRACT_REVISION;
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
  discardDecisions(sourceId: string): void;
  loadAcceptedGuidance(trajectory: BtccTrajectory, phases: ModelPhaseState[]): AcceptedPhaseGuidance[];
  publishGuidance(input: PublishPhaseGuidanceCommand): AcceptedPhaseGuidance;
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
