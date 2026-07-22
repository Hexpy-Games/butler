import type { ModelPhaseState } from "../../btcc/core/index.ts";
import {
  RETROSPECTIVE_DIMENSIONS,
  type BtccRetrospective,
  type GuidanceDecision,
  type GuidanceDisposition,
  type PhaseGuidanceCandidate,
  type RetrospectiveDecisionSet,
  type RetrospectiveDimension,
  type RetrospectiveFinding,
} from "./contracts.ts";

const PHASES = new Set<ModelPhaseState>([
  "conception_opening", "conception_deliberation", "contract_review",
  "planning", "planning_review", "task_execution", "task_review",
  "feedback_conception", "feedback_planning", "feedback_planning_review",
  "consolidation", "reporting",
]);
const DISPOSITIONS = new Set<GuidanceDisposition>([
  "promote", "merge", "supersede", "defer", "reject", "outside_learning_surface",
]);

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
  return {
    sourceId,
    summary: string(value.summary, "retrospective summary"),
    dimensions,
    strengths: strings(value.strengths, "retrospective strengths"),
    misses: strings(value.misses, "retrospective misses"),
    candidates: array(value.candidates, "retrospective candidates").map(decodeCandidate),
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
  const decisions = array(value.decisions, "guidance decisions").map(decodeDecision);
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.candidateId)) {
      throw new Error(`Duplicate guidance decision: ${decision.candidateId}`);
    }
    seen.add(decision.candidateId);
  }
  return { sourceId, decisions };
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
  return {
    candidateId: string(candidate.candidateId, "candidate id"),
    phase: phase as ModelPhaseState,
    scopeKind,
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
  return {
    candidateId: string(decision.candidateId, "decision candidate id"),
    disposition: disposition as GuidanceDisposition,
    guidanceId: string(decision.guidanceId, "decision guidance id"),
    rationale: string(decision.rationale, "decision rationale"),
  };
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
