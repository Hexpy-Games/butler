import type { BtccPersistenceTypes } from "../../../btcc/index.ts";
import { stableJson } from "./identity.ts";
import { SqliteImmutableRecordStore } from "./immutable-record-store.ts";

type Transition = BtccPersistenceTypes["transition"];
type Attempt = Extract<Transition, { kind: "select_work_task" }>["attempt"];
type Result = Extract<Transition, { kind: "submit_result" }>["product"];
type Review = Extract<Transition, {
  kind: "pass_task_review" | "fail_task_review";
}>["product"];
type Assemblies = Extract<Transition, {
  kind: "close_work_frontier";
}>["promotionAssemblies"];

export class ManagedArtifactRecordWriter {
  constructor(private readonly records: SqliteImmutableRecordStore) {}

  recordAttempt(attempt: Attempt): void {
    this.insert("attempt", {
      ref: attempt.ref,
      taskRef: attempt.taskRef,
      owningTurnId: attempt.owningTurnId,
      createdByTurnRevision: attempt.createdByTurnRevision,
      ...(attempt.previousAttemptRef ? { previousAttemptRef: attempt.previousAttemptRef } : {}),
      ...(attempt.correctionPlanRef ? { correctionPlanRef: attempt.correctionPlanRef } : {}),
    });
    this.insert("task_execution_target", attempt.executionTarget);
    this.insert("attempt_execution_target_binding", attempt.executionTargetBinding);
    if (!attempt.workspaceProvision) return;
    this.insert("workspace_provision_outbox", attempt.workspaceProvision.outbox);
    this.insert("target_baseline", attempt.workspaceProvision.baseline);
    this.insert("program_artifact_workspace", attempt.workspaceProvision.workspace);
    this.insert("workspace_provision_receipt", attempt.workspaceProvision.receipt);
    this.insert("workspace_provision_outcome", attempt.workspaceProvision.outcome);
  }

  recordResult(product: Result): void {
    this.insert("result_candidate", product.result);
    if (product.result.kind === "workspace_artifact") {
      this.insert("workspace_revision", product.result.workspaceRevision);
    }
    for (const revision of product.result.targetStateRevisions) {
      this.insert("target_state_revision", revision);
    }
  }

  recordReview(product: Review): void {
    this.insert("task_review", product.review);
    for (const observation of product.review.observations) {
      this.insert("review_observation", observation);
    }
    for (const finding of product.review.findings) this.insert("finding", finding);
  }

  recordPromotionAssemblies(assemblies: Assemblies): void {
    for (const assembly of assemblies) {
      this.insert("reviewed_promotion_candidate", assembly.candidate);
      this.insert("promotion_resolution_receipt", assembly.resolution);
    }
  }

  private insert<T extends { ref: { id: string; sha256: string } }>(
    kind: string,
    value: T,
  ): void {
    this.records.insert(value.ref.id, kind, value.ref.sha256, stableJson(value));
  }
}
