import type { BtccPersistenceTypes } from "../../../btcc/gateway-api.ts";
import { stableJson } from "./identity.ts";
import { SqliteImmutableRecordStore } from "./immutable-record-store.ts";

type PlanningCandidate = Extract<
  BtccPersistenceTypes["transition"],
  { kind: "submit_plan_candidate" }
>["product"]["candidate"];

export class ManagedPlanningRecordWriter {
  constructor(private readonly records: SqliteImmutableRecordStore) {}

  record(candidate: PlanningCandidate): void {
    if ("validationFindings" in candidate) {
      this.insert("plan_candidate_draft", candidate);
      return;
    }
    this.insert("plan_candidate", candidate);
    this.insert("plan", candidate.plan);
    for (const work of candidate.works) this.insert("work", work);
    for (const task of candidate.tasks) this.insert("task", task);
    for (const criterion of candidate.criteria) this.insert("acceptance_criterion", criterion);
    for (const question of candidate.verificationQuestions) {
      this.insert("verification_question", question);
    }
    this.insert("work_graph", candidate.workGraph);
    this.insert("artifact_lifecycle_relation", candidate.artifactLifecycle);
    this.insert("planning_candidate_bundle", candidate.bundle);
  }

  private insert<T extends { ref: { id: string; sha256: string } }>(
    kind: string,
    value: T,
  ): void {
    this.records.insert(value.ref.id, kind, value.ref.sha256, stableJson(value));
  }
}
