import type { ModelPhaseState } from "../core/index.ts";

export type PhaseGuidanceScope =
  | { kind: "user"; userRef: string }
  | { kind: "project"; projectRef: string }
  | { kind: "session"; sessionId: string }
  | { kind: "global" };

export type PhaseGuidanceRevisionRef = {
  guidanceId: string;
  phase: ModelPhaseState;
  scope: PhaseGuidanceScope;
  revision: number;
  contentSha256: string;
};

export type AcceptedPhaseGuidance = {
  guidanceId: string;
  phase: ModelPhaseState;
  scope: PhaseGuidanceScope;
  scopeRationale: string;
  scopeSourceRefs: string[];
  generalityBoundary:
    | "cross_project_user_preference"
    | "project_bound_strategy"
    | "session_bound_strategy"
    | "global_phase_practice";
  revisionKind: "promote" | "merge" | "supersede";
  predecessor?: PhaseGuidanceRevisionRef;
  revision: number;
  guidance: string;
  appliesWhen: string[];
  doesNotApplyWhen: string[];
  sourceIds: string[];
  contentSha256: string;
};

export type PhaseGuidanceDraft = Omit<
  AcceptedPhaseGuidance,
  "revisionKind" | "predecessor" | "revision" | "contentSha256"
>;

export type PublishPhaseGuidanceCommand =
  | { disposition: "promote"; guidance: PhaseGuidanceDraft }
  | {
      disposition: "merge" | "supersede";
      target: PhaseGuidanceRevisionRef;
      guidance: PhaseGuidanceDraft;
    };

export interface PhaseGuidanceReader {
  list(input: {
    phase: ModelPhaseState;
    userRef: string;
    sessionId: string;
    projectRef?: string;
  }): Promise<AcceptedPhaseGuidance[]> | AcceptedPhaseGuidance[];
}

export interface PhaseGuidanceRepository extends PhaseGuidanceReader {
  publish(input: PublishPhaseGuidanceCommand): AcceptedPhaseGuidance;
}
