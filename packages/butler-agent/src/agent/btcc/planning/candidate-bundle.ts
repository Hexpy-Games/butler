import {
  contentRef,
  stableJson,
  type ContentRef,
} from "../core/index.ts";
import type {
  PlanningCandidate,
  PlanningCandidateBundleEntry,
} from "./contracts.ts";

type CandidateRecords = Pick<
  PlanningCandidate,
  | "authoredSpecs"
  | "criteria"
  | "verificationQuestions"
  | "effectIntents"
  | "integrationCriteria"
  | "risks"
  | "assumptions"
  | "tasks"
  | "works"
  | "artifactLifecycle"
  | "workGraph"
  | "plan"
>;

export function planningCandidateBundleEntries(
  candidate: CandidateRecords,
): PlanningCandidateBundleEntry[] {
  return [
    ...entries("spec_revision", candidate.authoredSpecs),
    ...entries("acceptance_criterion", candidate.criteria),
    ...entries("verification_question", candidate.verificationQuestions),
    ...entries("effect_intent", candidate.effectIntents),
    ...entries("integration_criterion", candidate.integrationCriteria),
    ...entries("risk", candidate.risks),
    ...entries("assumption", candidate.assumptions),
    ...entries("task_revision", candidate.tasks),
    ...entries("work_revision", candidate.works),
    ...entries("artifact_lifecycle", [candidate.artifactLifecycle]),
    ...entries("work_graph", [candidate.workGraph]),
    ...entries("work_plan", [candidate.plan]),
  ];
}

function entries(
  recordKind: string,
  records: Array<{ ref: ContentRef } & Record<string, unknown>>,
): PlanningCandidateBundleEntry[] {
  return records.map((record) => {
    const { ref, ...semantic } = record;
    const semanticBytes = stableJson(semantic);
    if (contentRef(refKind(recordKind), semantic).sha256 !== ref.sha256) {
      throw new Error(`Planning bundle ${recordKind} bytes do not match ${ref.id}`);
    }
    return { recordKind, ref, semanticBytes };
  });
}

function refKind(recordKind: string): string {
  return {
    spec_revision: "spec-revision",
    acceptance_criterion: "acceptance-criterion",
    verification_question: "verification-question",
    effect_intent: "effect-intent",
    integration_criterion: "integration-criterion",
    risk: "planning-risk",
    assumption: "planning-assumption",
    task_revision: "task",
    work_revision: "work",
    artifact_lifecycle: "artifact-lifecycle",
    work_graph: "work-graph",
    work_plan: "work-plan",
  }[recordKind] ?? recordKind;
}
