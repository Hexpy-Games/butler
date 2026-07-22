import type { ModelPhaseState } from "../core/index.ts";

export type PhaseGuidanceScope =
  | { kind: "user"; userRef: string }
  | { kind: "project"; projectRef: string };

export type AcceptedPhaseGuidance = {
  guidanceId: string;
  phase: ModelPhaseState;
  scope: PhaseGuidanceScope;
  revision: number;
  guidance: string;
  appliesWhen: string[];
  doesNotApplyWhen: string[];
  sourceIds: string[];
  contentSha256: string;
};

export interface PhaseGuidanceReader {
  list(input: {
    phase: ModelPhaseState;
    userRef: string;
    projectRef?: string;
  }): Promise<AcceptedPhaseGuidance[]> | AcceptedPhaseGuidance[];
}

export interface PhaseGuidanceRepository extends PhaseGuidanceReader {
  publish(input: Omit<AcceptedPhaseGuidance, "revision" | "contentSha256">): AcceptedPhaseGuidance;
}
