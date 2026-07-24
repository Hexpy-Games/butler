import {
  contentRef,
  stableJson,
} from "../core/index.ts";
import type { PlanningCandidate } from "./contracts.ts";
import { planningCandidateBundleEntries } from "./candidate-bundle.ts";

export function attestCandidateBundle(candidate: PlanningCandidate): void {
  attestExactBundle(candidate);
}

function attestExactBundle(candidate: PlanningCandidate): void {
  const entries = planningCandidateBundleEntries(candidate);
  for (const entry of entries) {
    const semantic = JSON.parse(entry.semanticBytes) as unknown;
    if (stableJson(semantic) !== entry.semanticBytes ||
      contentRef(refKind(entry.recordKind), semantic).sha256 !== entry.ref.sha256) {
      throw new Error(`Planning Review bundle entry changed: ${entry.ref.id}`);
    }
  }
  const { ref: _ref, ...bundleBody } = candidate.bundle;
  const expected = contentRef("planning-candidate-bundle", bundleBody);
  if (expected.id !== candidate.bundle.ref.id || expected.sha256 !== candidate.bundle.ref.sha256) {
    throw new Error("Planning Review bundle identity changed");
  }
  if (stableJson(entries.map((entry) => entry.ref)) !== stableJson(candidate.bundle.recordRefs)) {
    throw new Error("Planning Review bundle record index changed");
  }
}

function refKind(recordKind: string): string {
  return {
    spec_revision: "spec-revision", acceptance_criterion: "acceptance-criterion",
    verification_question: "verification-question", effect_intent: "effect-intent",
    integration_criterion: "integration-criterion", risk: "planning-risk",
    assumption: "planning-assumption", task_revision: "task", work_revision: "work",
    artifact_lifecycle: "artifact-lifecycle", work_graph: "work-graph", work_plan: "work-plan",
  }[recordKind] ?? recordKind;
}
