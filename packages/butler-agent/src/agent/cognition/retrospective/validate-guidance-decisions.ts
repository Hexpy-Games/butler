import {
  phaseGuidanceRevisionRef,
  type AcceptedPhaseGuidance,
  type PhaseGuidanceScope,
} from "../../btcc/guidance/index.ts";
import type {
  BtccTrajectory,
  GuidanceDecision,
  PhaseGuidanceCandidate,
  RetrospectiveDecisionSet,
} from "./contracts.ts";
import { trajectorySourceRefs } from "./source-reference-index.ts";

export function validateGuidanceDecisions(input: {
  decisions: RetrospectiveDecisionSet;
  trajectory: BtccTrajectory;
  candidates: PhaseGuidanceCandidate[];
  acceptedGuidance: AcceptedPhaseGuidance[];
}): void {
  const allowedRefs = trajectorySourceRefs(input.trajectory);
  const candidates = new Map(input.candidates.map((entry) => [entry.candidateId, entry]));
  for (const decision of input.decisions.decisions) {
    if (!isAcceptedGuidanceDecision(decision)) continue;
    validateAcceptedScope(decision, input.trajectory, allowedRefs);
    const candidate = candidates.get(decision.candidateId);
    if (!candidate) throw new Error("Accepted guidance candidate does not exist");
    const scope = acceptedScope(decision, input.trajectory);
    if (decision.disposition === "promote") {
      const existing = findGuidance(
        input.acceptedGuidance,
        decision.guidanceId,
        candidate.phase,
        scope,
      );
      if (existing && !samePromotedGuidance(existing, decision, input.trajectory)) {
        throw new Error("Promote requires a new stable guidance ID in its phase and scope");
      }
      continue;
    }
    if (
      decision.targetRevision.guidanceId !== decision.guidanceId ||
      decision.targetRevision.phase !== candidate.phase ||
      !sameScope(decision.targetRevision.scope, scope)
    ) {
      throw new Error("Guidance revision target must preserve ID, phase, and scope");
    }
    const target = findExactRevision(input.acceptedGuidance, decision.targetRevision);
    if (!target) {
      const current = findGuidance(
        input.acceptedGuidance,
        decision.guidanceId,
        candidate.phase,
        scope,
      );
      if (!current || !sameRevisedGuidance(current, decision, input.trajectory)) {
        throw new Error("Guidance revision target is not an exact supplied active revision");
      }
    }
  }
}

function samePromotedGuidance(
  existing: AcceptedPhaseGuidance,
  decision: Extract<GuidanceDecision, { disposition: "promote" }>,
  trajectory: BtccTrajectory,
): boolean {
  return existing.revisionKind === "promote" &&
    existing.guidance === decision.acceptedGuidance &&
    existing.scopeRationale === decision.acceptedScopeRationale &&
    existing.generalityBoundary === decision.acceptedGeneralityBoundary &&
    sameStrings(existing.scopeSourceRefs, decision.acceptedScopeSourceRefs) &&
    sameStrings(existing.appliesWhen, decision.acceptedAppliesWhen) &&
    sameStrings(existing.doesNotApplyWhen, decision.acceptedDoesNotApplyWhen) &&
    existing.sourceIds.includes(trajectory.sourceId);
}

function sameRevisedGuidance(
  existing: AcceptedPhaseGuidance,
  decision: Extract<GuidanceDecision, { disposition: "merge" | "supersede" }>,
  trajectory: BtccTrajectory,
): boolean {
  return existing.revisionKind === decision.disposition &&
    Boolean(existing.predecessor) &&
    sameRevisionRef(existing.predecessor!, decision.targetRevision) &&
    existing.guidance === decision.acceptedGuidance &&
    existing.scopeRationale === decision.acceptedScopeRationale &&
    existing.generalityBoundary === decision.acceptedGeneralityBoundary &&
    decision.acceptedScopeSourceRefs.every((ref) => existing.scopeSourceRefs.includes(ref)) &&
    sameStrings(existing.appliesWhen, decision.acceptedAppliesWhen) &&
    sameStrings(existing.doesNotApplyWhen, decision.acceptedDoesNotApplyWhen) &&
    existing.sourceIds.includes(trajectory.sourceId);
}

export function isAcceptedGuidanceDecision(
  decision: GuidanceDecision,
): decision is Extract<GuidanceDecision, { disposition: "promote" | "merge" | "supersede" }> {
  return decision.disposition === "promote" ||
    decision.disposition === "merge" ||
    decision.disposition === "supersede";
}

function validateAcceptedScope(
  decision: Extract<GuidanceDecision, { disposition: "promote" | "merge" | "supersede" }>,
  trajectory: BtccTrajectory,
  allowedRefs: Set<string>,
): void {
  if (decision.acceptedScopeSourceRefs.length === 0) {
    throw new Error("Accepted guidance requires exact scope source refs");
  }
  if (decision.acceptedScopeSourceRefs.some((ref) => !allowedRefs.has(ref))) {
    throw new Error("Accepted guidance scope cites a source ref outside the exact trajectory");
  }
  if (
    decision.acceptedScopeKind === "user" &&
    decision.acceptedGeneralityBoundary !== "cross_project_user_preference"
  ) throw new Error("User guidance requires a cross-project user-preference boundary");
  if (
    decision.acceptedScopeKind === "project" &&
    decision.acceptedGeneralityBoundary !== "project_bound_strategy"
  ) throw new Error("Project guidance requires a project-bound strategy boundary");
  if (decision.acceptedScopeKind === "project" && !trajectory.projectRef) {
    throw new Error("Project guidance requires a project-bound trajectory");
  }
}

function acceptedScope(
  decision: Extract<GuidanceDecision, { disposition: "promote" | "merge" | "supersede" }>,
  trajectory: BtccTrajectory,
): PhaseGuidanceScope {
  return decision.acceptedScopeKind === "project"
    ? { kind: "project", projectRef: trajectory.projectRef! }
    : { kind: "user", userRef: trajectory.userRef };
}

function findGuidance(
  entries: AcceptedPhaseGuidance[],
  guidanceId: string,
  phase: AcceptedPhaseGuidance["phase"],
  scope: PhaseGuidanceScope,
): AcceptedPhaseGuidance | undefined {
  return entries.find((entry) =>
    entry.guidanceId === guidanceId && entry.phase === phase && sameScope(entry.scope, scope),
  );
}

function findExactRevision(
  entries: AcceptedPhaseGuidance[],
  target: GuidanceRevisionTarget,
): AcceptedPhaseGuidance | undefined {
  return entries.find((entry) => {
    const ref = phaseGuidanceRevisionRef(entry);
    return ref.guidanceId === target.guidanceId && ref.phase === target.phase &&
      sameScope(ref.scope, target.scope) && ref.revision === target.revision &&
      ref.contentSha256 === target.contentSha256;
  });
}

type GuidanceRevisionTarget = Extract<
  GuidanceDecision,
  { disposition: "merge" | "supersede" }
>["targetRevision"];

function sameScope(left: PhaseGuidanceScope, right: PhaseGuidanceScope): boolean {
  return left.kind === right.kind && (
    left.kind === "user"
      ? left.userRef === (right as Extract<PhaseGuidanceScope, { kind: "user" }>).userRef
      : left.projectRef === (right as Extract<PhaseGuidanceScope, { kind: "project" }>).projectRef
  );
}

function sameRevisionRef(
  left: GuidanceRevisionTarget,
  right: GuidanceRevisionTarget,
): boolean {
  return left.guidanceId === right.guidanceId && left.phase === right.phase &&
    sameScope(left.scope, right.scope) && left.revision === right.revision &&
    left.contentSha256 === right.contentSha256;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
