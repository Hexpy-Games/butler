import type { ModelPhaseState } from "../../btcc/core/index.ts";
import type {
  PhaseGuidanceRevisionRef,
  PhaseGuidanceScope,
} from "../../btcc/guidance/index.ts";
import {
  RETROSPECTIVE_DIMENSIONS,
  GUIDANCE_DECISION_CONTRACT_REVISION,
  type BtccRetrospective,
  type GuidanceDecision,
  type GuidanceDisposition,
  type PhaseGuidanceCandidate,
  type RetrospectiveDecisionSet,
  type RetrospectiveDimension,
  type RetrospectiveFinding,
} from "./contracts.ts";
import { RETROSPECTIVE_RUBRIC_REVISION } from "./evaluation-rubric.ts";

const PHASES = new Set<ModelPhaseState>([
  "conception_opening", "assisted_answer", "conception_deliberation", "contract_review",
  "planning", "planning_review", "task_execution", "task_review",
  "feedback_conception", "feedback_planning", "feedback_planning_review",
  "consolidation", "reporting",
]);
const DISPOSITIONS = new Set<GuidanceDisposition>([
  "promote", "merge", "supersede", "defer", "reject", "outside_learning_surface",
]);
const ACCEPTED_DISPOSITIONS = new Set<GuidanceDisposition>(["promote", "merge", "supersede"]);

export function decodeRetrospective(text: string, sourceId: string): BtccRetrospective {
  const value = record(parseJson(text), "retrospective");
  const dimensions = {} as Record<RetrospectiveDimension, RetrospectiveFinding>;
  const rawDimensions = record(value.dimensions, "retrospective dimensions");
  for (const dimension of RETROSPECTIVE_DIMENSIONS) {
    const finding = record(rawDimensions[dimension], `dimension ${dimension}`);
    const score = number(finding.score, `${dimension} score`);
    if (score < 1 || score > 5) throw new Error(`${dimension} score must be between 1 and 5`);
    dimensions[dimension] = {
      score,
      assessment: string(finding.assessment, `${dimension} assessment`),
      sourceRefs: strings(finding.sourceRefs, `${dimension} sourceRefs`),
    };
  }
  const candidates = array(value.candidates, "retrospective candidates").map(decodeCandidate);
  rejectDuplicateCandidateIds(candidates);
  if (value.rubricRevision !== RETROSPECTIVE_RUBRIC_REVISION) {
    throw new Error("Retrospective rubric revision does not match the requested rubric");
  }
  return {
    sourceId,
    rubricRevision: RETROSPECTIVE_RUBRIC_REVISION,
    summary: string(value.summary, "retrospective summary"),
    dimensions,
    strengths: strings(value.strengths, "retrospective strengths"),
    misses: strings(value.misses, "retrospective misses"),
    candidates,
    outsideLearningSurface: array(
      value.outsideLearningSurface,
      "outside learning surface",
    ).map((item) => {
      const finding = record(item, "outside learning finding");
      return {
        finding: string(finding.finding, "outside finding"),
        requiredChange: string(finding.requiredChange, "outside required change"),
        sourceRefs: strings(finding.sourceRefs, "outside sourceRefs"),
      };
    }),
  };
}

export function decodeDecisionSet(text: string, sourceId: string): RetrospectiveDecisionSet {
  const value = record(parseJson(text), "guidance decision set");
  if (value.contractRevision !== GUIDANCE_DECISION_CONTRACT_REVISION) {
    throw new Error("Guidance decision contract revision does not match");
  }
  const decisions = array(value.decisions, "guidance decisions").map(decodeDecision);
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.candidateId)) {
      throw new Error(`Duplicate guidance decision: ${decision.candidateId}`);
    }
    seen.add(decision.candidateId);
  }
  return { sourceId, contractRevision: GUIDANCE_DECISION_CONTRACT_REVISION, decisions };
}

function decodeCandidate(value: unknown): PhaseGuidanceCandidate {
  const candidate = record(value, "phase guidance candidate");
  const phase = string(candidate.phase, "candidate phase");
  if (!PHASES.has(phase as ModelPhaseState)) throw new Error(`Unknown guidance phase: ${phase}`);
  const scopeKind = string(candidate.scopeKind, "candidate scopeKind");
  if (scopeKind !== "user" && scopeKind !== "project") {
    throw new Error(`Unknown guidance scope: ${scopeKind}`);
  }
  const confidence = number(candidate.confidence, "candidate confidence");
  if (confidence < 0 || confidence > 1) throw new Error("Candidate confidence must be 0..1");
  const scopeSourceRefs = strings(candidate.scopeSourceRefs, "candidate scopeSourceRefs");
  if (scopeSourceRefs.length === 0) throw new Error("Candidate scope requires exact source refs");
  return {
    candidateId: string(candidate.candidateId, "candidate id"),
    phase: phase as ModelPhaseState,
    scopeKind,
    scopeRationale: string(candidate.scopeRationale, "candidate scopeRationale"),
    scopeSourceRefs,
    generalityBoundary: guidanceBoundary(
      candidate.generalityBoundary,
      "candidate generalityBoundary",
    ),
    problem: string(candidate.problem, "candidate problem"),
    guidance: string(candidate.guidance, "candidate guidance"),
    appliesWhen: strings(candidate.appliesWhen, "candidate appliesWhen"),
    doesNotApplyWhen: strings(candidate.doesNotApplyWhen, "candidate doesNotApplyWhen"),
    expectedBenefit: string(candidate.expectedBenefit, "candidate expectedBenefit"),
    risks: strings(candidate.risks, "candidate risks"),
    confidence,
    sourceRefs: strings(candidate.sourceRefs, "candidate sourceRefs"),
  };
}

function decodeDecision(value: unknown): GuidanceDecision {
  const decision = record(value, "guidance decision");
  const disposition = string(decision.disposition, "guidance disposition");
  if (!DISPOSITIONS.has(disposition as GuidanceDisposition)) {
    throw new Error(`Unknown guidance disposition: ${disposition}`);
  }
  const base = {
    candidateId: string(decision.candidateId, "decision candidate id"),
    guidanceId: string(decision.guidanceId, "decision guidance id"),
    rationale: string(decision.rationale, "decision rationale"),
  };
  if (!ACCEPTED_DISPOSITIONS.has(disposition as GuidanceDisposition)) {
    return { ...base, disposition: disposition as "defer" | "reject" | "outside_learning_surface" };
  }
  const acceptedScopeKind = guidanceScopeKind(decision.acceptedScopeKind, "accepted scopeKind");
  const accepted = {
    acceptedScopeKind,
    acceptedScopeRationale: string(
      decision.acceptedScopeRationale,
      "accepted scopeRationale",
    ),
    acceptedScopeSourceRefs: strings(
      decision.acceptedScopeSourceRefs,
      "accepted scopeSourceRefs",
    ),
    acceptedGeneralityBoundary: guidanceBoundary(
      decision.acceptedGeneralityBoundary,
      "accepted generalityBoundary",
    ),
    acceptedGuidance: string(decision.acceptedGuidance, "accepted guidance"),
    acceptedAppliesWhen: strings(decision.acceptedAppliesWhen, "accepted appliesWhen"),
    acceptedDoesNotApplyWhen: strings(
      decision.acceptedDoesNotApplyWhen,
      "accepted doesNotApplyWhen",
    ),
  };
  if (disposition === "promote") return { ...base, disposition, ...accepted };
  return {
    ...base,
    disposition: disposition as "merge" | "supersede",
    targetRevision: decodeRevisionRef(decision.targetRevision),
    ...accepted,
  };
}

function decodeRevisionRef(value: unknown): PhaseGuidanceRevisionRef {
  const target = record(value, "target guidance revision");
  const phase = string(target.phase, "target revision phase");
  if (!PHASES.has(phase as ModelPhaseState)) {
    throw new Error(`Unknown target guidance phase: ${phase}`);
  }
  const revision = number(target.revision, "target revision number");
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error("Target guidance revision must be a positive integer");
  }
  return {
    guidanceId: string(target.guidanceId, "target guidance id"),
    phase: phase as ModelPhaseState,
    scope: decodeGuidanceScope(target.scope),
    revision,
    contentSha256: string(target.contentSha256, "target guidance content hash"),
  };
}

function decodeGuidanceScope(value: unknown): PhaseGuidanceScope {
  const scope = record(value, "target guidance scope");
  const kind = string(scope.kind, "target guidance scope kind");
  if (kind === "user") {
    return { kind, userRef: string(scope.userRef, "target guidance user ref") };
  }
  if (kind === "project") {
    return { kind, projectRef: string(scope.projectRef, "target guidance project ref") };
  }
  throw new Error(`Unknown target guidance scope: ${kind}`);
}

function rejectDuplicateCandidateIds(candidates: PhaseGuidanceCandidate[]): void {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.candidateId)) {
      throw new Error(`Duplicate guidance candidate: ${candidate.candidateId}`);
    }
    seen.add(candidate.candidateId);
  }
}

function guidanceBoundary(
  value: unknown,
  label: string,
): PhaseGuidanceCandidate["generalityBoundary"] {
  const boundary = string(value, label);
  if (boundary !== "cross_project_user_preference" && boundary !== "project_bound_strategy") {
    throw new Error(`Unknown guidance generality boundary: ${boundary}`);
  }
  return boundary;
}

function guidanceScopeKind(value: unknown, label: string): "user" | "project" {
  const scope = string(value, label);
  if (scope !== "user" && scope !== "project") {
    throw new Error(`Unknown accepted guidance scope: ${scope}`);
  }
  return scope;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const payload = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")
    : trimmed;
  return JSON.parse(payload);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be nonempty`);
  return value.trim();
}

function strings(value: unknown, label: string): string[] {
  return array(value, label).map((item) => string(item, label));
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be numeric`);
  return value;
}
