import type {
  AcceptedPhaseGuidance,
  PhaseGuidanceDraft,
  PhaseGuidanceRevisionRef,
  PhaseGuidanceScope,
} from "../../../../btcc/gateway-api.ts";
import { digest, stableJson } from "../identity.ts";

export type ModelPhaseState = AcceptedPhaseGuidance["phase"];
export type GuidanceStorageScope = { kind: string; id: string };

const PHASES = new Set<ModelPhaseState>([
  "conception_opening",
  "assisted_answer",
  "conception_deliberation",
  "contract_review",
  "planning",
  "planning_review",
  "task_execution",
  "task_review",
  "feedback_conception",
  "feedback_planning",
  "feedback_planning_review",
  "consolidation",
  "reporting",
]);

export function storageScope(scope: PhaseGuidanceScope): GuidanceStorageScope {
  switch (scope.kind) {
    case "user": return { kind: "user", id: scope.userRef };
    case "project": return { kind: "project", id: scope.projectRef };
    case "session": return { kind: "session", id: scope.sessionId };
    case "global": return { kind: "global", id: "global" };
  }
}

export function validateGuidanceDraft(input: PhaseGuidanceDraft): void {
  if (!input.guidanceId.trim() || !input.guidance.trim()) {
    throw new Error("BTCC phase guidance requires an id and guidance text");
  }
  if (!input.scopeRationale.trim() || input.scopeSourceRefs.length === 0) {
    throw new Error("BTCC phase guidance requires reviewed scope authority");
  }
  if (
    input.scope.kind === "user" &&
    input.generalityBoundary !== "cross_project_user_preference"
  ) throw new Error("User guidance requires a cross-project boundary");
  if (
    input.scope.kind === "project" &&
    input.generalityBoundary !== "project_bound_strategy"
  ) throw new Error("Project guidance requires a project-bound boundary");
  if (
    input.scope.kind === "session" &&
    input.generalityBoundary !== "session_bound_strategy"
  ) throw new Error("Session guidance requires a session-bound boundary");
  if (
    input.scope.kind === "global" &&
    input.generalityBoundary !== "global_phase_practice"
  ) throw new Error("Global guidance requires a global phase-practice boundary");
  if (!storageScope(input.scope).id.trim()) {
    throw new Error("BTCC phase guidance requires a scope id");
  }
}

export function validateRevisionIdentity(
  target: PhaseGuidanceRevisionRef,
  guidance: PhaseGuidanceDraft,
): void {
  if (
    target.guidanceId !== guidance.guidanceId ||
    target.phase !== guidance.phase ||
    !sameScope(target.scope, guidance.scope)
  ) throw new Error("phase_guidance_revision_identity_changed");
}

export function preserveGuidanceProvenance(
  target: AcceptedPhaseGuidance,
  guidance: PhaseGuidanceDraft,
): PhaseGuidanceDraft {
  return {
    ...guidance,
    scopeSourceRefs: union(target.scopeSourceRefs, guidance.scopeSourceRefs),
    sourceIds: union(target.sourceIds, guidance.sourceIds),
  };
}

export function createAcceptedGuidance(
  guidance: PhaseGuidanceDraft,
  revisionKind: AcceptedPhaseGuidance["revisionKind"],
  revision: number,
  predecessor?: PhaseGuidanceRevisionRef,
): AcceptedPhaseGuidance {
  const content = {
    ...guidance,
    revisionKind,
    ...(predecessor ? { predecessor } : {}),
  };
  return {
    ...content,
    revision,
    contentSha256: digest(stableJson(content)),
  };
}

export function sameGuidanceRevision(
  guidance: AcceptedPhaseGuidance,
  ref: PhaseGuidanceRevisionRef,
): boolean {
  return guidance.guidanceId === ref.guidanceId && guidance.phase === ref.phase &&
    sameScope(guidance.scope, ref.scope) && guidance.revision === ref.revision &&
    guidance.contentSha256 === ref.contentSha256;
}

export function decodeGuidance(value: string): AcceptedPhaseGuidance | null {
  try {
    const parsed = JSON.parse(value) as Partial<AcceptedPhaseGuidance>;
    if (!validGuidanceShape(parsed) || !validGuidanceBoundary(parsed)) return null;
    if (
      (parsed.revisionKind === "promote" && parsed.predecessor !== undefined) ||
      (parsed.revisionKind !== "promote" && !validRevisionRef(parsed.predecessor))
    ) return null;
    const guidance = parsed as AcceptedPhaseGuidance;
    return hasValidContentHash(guidance) ? guidance : null;
  } catch {
    return null;
  }
}

function validGuidanceShape(parsed: Partial<AcceptedPhaseGuidance>): boolean {
  return typeof parsed.guidanceId === "string" &&
    typeof parsed.phase === "string" &&
    PHASES.has(parsed.phase as ModelPhaseState) &&
    typeof parsed.guidance === "string" &&
    typeof parsed.scopeRationale === "string" &&
    Array.isArray(parsed.scopeSourceRefs) &&
    validBoundaryValue(parsed.generalityBoundary) &&
    Number.isInteger(parsed.revision) && Number(parsed.revision) >= 1 &&
    validRevisionKind(parsed.revisionKind) &&
    typeof parsed.contentSha256 === "string" &&
    Array.isArray(parsed.appliesWhen) &&
    Array.isArray(parsed.doesNotApplyWhen) &&
    Array.isArray(parsed.sourceIds) &&
    validScope(parsed.scope);
}

function validGuidanceBoundary(parsed: Partial<AcceptedPhaseGuidance>): boolean {
  if (!parsed.scope) return false;
  if (parsed.scope.kind === "user") {
    return parsed.generalityBoundary === "cross_project_user_preference";
  }
  if (parsed.scope.kind === "project") {
    return parsed.generalityBoundary === "project_bound_strategy";
  }
  if (parsed.scope.kind === "session") {
    return parsed.generalityBoundary === "session_bound_strategy";
  }
  return parsed.generalityBoundary === "global_phase_practice";
}

function validBoundaryValue(value: unknown): boolean {
  return value === "cross_project_user_preference" ||
    value === "project_bound_strategy" ||
    value === "session_bound_strategy" ||
    value === "global_phase_practice";
}

function validRevisionKind(value: unknown): boolean {
  return value === "promote" || value === "merge" || value === "supersede";
}

function hasValidContentHash(guidance: AcceptedPhaseGuidance): boolean {
  const content = { ...guidance } as Partial<AcceptedPhaseGuidance>;
  delete content.revision;
  delete content.contentSha256;
  return digest(stableJson(content)) === guidance.contentSha256;
}

function validRevisionRef(value: unknown): value is PhaseGuidanceRevisionRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Partial<PhaseGuidanceRevisionRef>;
  return typeof ref.guidanceId === "string" && typeof ref.phase === "string" &&
    PHASES.has(ref.phase as ModelPhaseState) && Number.isInteger(ref.revision) &&
    Number(ref.revision) > 0 && typeof ref.contentSha256 === "string" &&
    Boolean(ref.contentSha256) && validScope(ref.scope);
}

function validScope(value: unknown): value is PhaseGuidanceScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Partial<PhaseGuidanceScope> & Record<string, unknown>;
  if (scope.kind === "user") {
    return typeof scope.userRef === "string" && Boolean(scope.userRef);
  }
  if (scope.kind === "project") {
    return typeof scope.projectRef === "string" && Boolean(scope.projectRef);
  }
  if (scope.kind === "session") {
    return typeof scope.sessionId === "string" && Boolean(scope.sessionId);
  }
  return scope.kind === "global";
}

function sameScope(left: PhaseGuidanceScope, right: PhaseGuidanceScope): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "user":
      return left.userRef === (right as Extract<PhaseGuidanceScope, { kind: "user" }>).userRef;
    case "project":
      return left.projectRef ===
        (right as Extract<PhaseGuidanceScope, { kind: "project" }>).projectRef;
    case "session":
      return left.sessionId ===
        (right as Extract<PhaseGuidanceScope, { kind: "session" }>).sessionId;
    case "global": return true;
  }
}

function union(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}
