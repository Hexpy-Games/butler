import type { Database } from "bun:sqlite";
import {
  assertLogicalLedgerMutationId,
  createLogicalLedgerBundle,
  logicalLedgerRecords,
  acceptFeedbackAuthority,
  acceptReviewedPlanAuthority,
  bindManagedProgram,
  type WorkLedgerCommit,
  type ManagedProgramAuthority,
} from "../../../../btcc/index.ts";
import { stableJson } from "../identity.ts";
import { WorkLedgerCommitJournal } from "./work-ledger-commit-journal.ts";
import { SqliteReviewedGraphInstaller } from "./reviewed-graph-installer.ts";
import { SqliteImplementationRepairWriter } from "./implementation-repair-writer.ts";
import { SqlitePromotionFrontierWriter } from "./promotion-frontier-writer.ts";
import { SqliteProgramAuthorityWriter } from "./program-authority-writer.ts";
import { SqliteWorkLedgerProgramReader } from "./work-ledger-program-reader.ts";
import { validateFrontierMutation } from "./validate-frontier-mutation.ts";

export class SqliteWorkLedgerMutationWriter {
  private readonly journal: WorkLedgerCommitJournal;
  private readonly graphRevisions: SqliteReviewedGraphInstaller;
  private readonly implementationRepairs: SqliteImplementationRepairWriter;
  private readonly promotionFrontier: SqlitePromotionFrontierWriter;
  private readonly programAuthority: SqliteProgramAuthorityWriter;
  private readonly programs: SqliteWorkLedgerProgramReader;

  constructor(private readonly db: Database) {
    this.journal = new WorkLedgerCommitJournal(db);
    this.graphRevisions = new SqliteReviewedGraphInstaller(db);
    this.implementationRepairs = new SqliteImplementationRepairWriter(db);
    this.promotionFrontier = new SqlitePromotionFrontierWriter(db);
    this.programAuthority = new SqliteProgramAuthorityWriter(db);
    this.programs = new SqliteWorkLedgerProgramReader(db);
  }

  commitAtomically(input: WorkLedgerCommit): void {
    this.db.transaction(() => {
      const boundary = this.journal.open(input);
      if (boundary.kind === "replayed") return;
      const previous = this.programs.load(programIdOf(input));
      assertLogicalLedgerMutationId(input, previous);
      validateFrontierMutation(previous, input);
      const records = logicalLedgerRecords(input.mutation, previous);
      this.journal.materializeSourceRecords(records);
      const authority = plannedAuthority(previous, input);
      this.apply(input, authority);
      const next = this.programs.load(programIdOf(input));
      if (!next) throw new Error("Work Ledger mutation did not materialize its next manifest");
      if (authority) assertAuthorityProjection(next, authority);
      this.journal.close(
        input,
        boundary.baseRevision,
        createLogicalLedgerBundle({ commit: input, previous, next }),
        records,
      );
    })();
  }

  private apply(
    input: WorkLedgerCommit,
    authority?: ReturnType<typeof plannedAuthority>,
  ): void {
    const mutation = input.mutation;
    switch (mutation.kind) {
      case "bind_program":
        this.programAuthority.bindProgram(mutation, requireAuthority(authority));
        return;
      case "install_reviewed_plan":
        this.programAuthority.installReviewedPlan(
          mutation.product,
          requireAuthority(authority),
        );
        return;
      case "select_attempt":
        this.selectAttempt(mutation.cursor.programId, mutation.attempt);
        return;
      case "attach_result":
        this.attachResult(mutation.product);
        return;
      case "attach_review":
        this.attachReview(mutation.product);
        return;
      case "accept_feedback_plan":
        this.acceptFeedbackPlan(mutation.product, requireAuthority(authority));
        return;
      case "close_implementation_frontier":
        this.promotionFrontier.closeImplementation(mutation);
        return;
      case "close_promotion_frontier":
        this.promotionFrontier.close(mutation);
        return;
      case "accept_managed_deferral":
        this.acceptManagedDeferral(mutation);
        return;
      case "accept_promotion_deferral":
        this.promotionFrontier.defer(mutation);
        return;
      case "close_deferred_promotion_frontier":
        this.promotionFrontier.closeDeferred(mutation);
        return;
    }
  }

  private selectAttempt(
    programId: string,
    attempt: Extract<WorkLedgerCommit["mutation"], { kind: "select_attempt" }>["attempt"],
  ): void {
    const task = this.db.query<{ work_id: string }, [string, string]>(`
      SELECT work_id FROM btcc_tasks
      WHERE program_id = ? AND task_id = ? AND status = 'planned' AND is_active = 1
    `).get(programId, attempt.attemptRecord.taskRef.id);
    if (!task) throw new Error("Work Ledger selected Task is not planned");
    this.db.query(`
      INSERT INTO btcc_attempts (
        attempt_id, program_id, task_id, attempt_ref, previous_attempt_id,
        correction_plan_ref, execution_target_ref, execution_target_binding_ref, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready')
    `).run(
      attempt.attemptRecord.ref.id,
      programId,
      attempt.attemptRecord.taskRef.id,
      stableJson(attempt.attemptRecord.ref),
      attempt.attemptRecord.previousAttemptRef?.id ?? null,
      attempt.attemptRecord.correctionPlanRef?.id ?? null,
      stableJson(attempt.executionTargetRef),
      stableJson(attempt.executionTargetBinding.ref),
    );
    this.db.query("UPDATE btcc_work_items SET status = 'active' WHERE work_id = ?")
      .run(task.work_id);
    this.db.query(`
      UPDATE btcc_tasks SET status = 'selected', current_attempt_id = ? WHERE task_id = ?
    `).run(attempt.attemptRecord.ref.id, attempt.attemptRecord.taskRef.id);
    this.db.query(`
      UPDATE btcc_programs SET pending_correction_plan_ref = NULL WHERE program_id = ?
    `).run(programId);
    this.bumpManifest(programId);
  }

  private attachResult(
    product: Extract<WorkLedgerCommit["mutation"], { kind: "attach_result" }>["product"],
  ): void {
    const result = product.result;
    this.updateAttempt(result.attemptRef.id, "ready", "result_submitted", result.ref.id);
    const updated = this.db.query(`
      UPDATE btcc_tasks SET status = 'result_submitted', result_ref = ?
      WHERE task_id = ? AND current_attempt_id = ? AND status = 'selected'
    `).run(result.ref.id, result.taskRef.id, result.attemptRef.id);
    if (updated.changes !== 1) throw new Error("Work Ledger Result lost its selected Task");
    this.bumpManifest(this.programIdForTask(result.taskRef.id));
  }

  private attachReview(
    product: Extract<WorkLedgerCommit["mutation"], { kind: "attach_review" }>["product"],
  ): void {
    const status = product.review.verdict === "passed" ? "accepted" : "review_failed";
    this.updateAttempt(
      product.review.attemptRef.id,
      "result_submitted",
      status,
      undefined,
      product.review.ref.id,
    );
    const updated = this.db.query(`
      UPDATE btcc_tasks SET status = ?, review_ref = ?,
        revalidation_source_json = CASE WHEN ? = 'accepted' THEN NULL
          ELSE revalidation_source_json END
      WHERE task_id = ? AND current_attempt_id = ? AND status = 'result_submitted'
    `).run(
      status,
      product.review.ref.id,
      status,
      product.review.taskRef.id,
      product.review.attemptRef.id,
    );
    if (updated.changes !== 1) throw new Error("Work Ledger Review lost its submitted Task");
    const task = this.taskOwner(product.review.taskRef.id);
    if (status === "accepted") {
      this.implementationRepairs.closeDisposition(task.programId);
      this.db.query(`
        UPDATE btcc_work_items SET status = 'closed'
        WHERE work_id = ? AND NOT EXISTS (
          SELECT 1 FROM btcc_tasks
          WHERE work_id = ? AND is_active = 1 AND status != 'accepted'
        )
      `).run(task.workId, task.workId);
    }
    this.bumpManifest(task.programId);
  }

  private acceptFeedbackPlan(
    product: Extract<WorkLedgerCommit["mutation"], { kind: "accept_feedback_plan" }>["product"],
    authority: ManagedProgramAuthority,
  ): void {
    if (product.candidate.correctionKind === "implementation_repair") {
      this.implementationRepairs.accept(product);
      return;
    }
    this.graphRevisions.install(product, authority);
  }

  private acceptManagedDeferral(
    mutation: Extract<WorkLedgerCommit["mutation"], { kind: "accept_managed_deferral" }>,
  ): void {
    const updated = this.db.query(`
      UPDATE btcc_programs SET active_deferral_ref = ?, active_deferral_turn_id = ?,
        manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND manifest_revision = ?
        AND active_deferral_ref IS NULL
    `).run(
      mutation.product.anchor.ref.id,
      mutation.product.anchor.sourceTurnId,
      mutation.cursor.programId,
      mutation.cursor.expectedManifestRevision,
    );
    if (updated.changes !== 1) throw new Error("Work Ledger deferral base changed");
  }

  private bumpManifest(programId: string): void {
    const result = this.db.query(`
      UPDATE btcc_programs SET manifest_revision = manifest_revision + 1 WHERE program_id = ?
    `).run(programId);
    if (result.changes !== 1) throw new Error("Work Ledger Program disappeared");
  }


  private updateAttempt(
    attemptId: string,
    expectedStatus: string,
    status: string,
    resultRef?: string,
    reviewRef?: string,
  ): void {
    const updated = this.db.query(`
      UPDATE btcc_attempts SET status = ?, result_ref = COALESCE(?, result_ref),
        review_ref = COALESCE(?, review_ref) WHERE attempt_id = ? AND status = ?
    `).run(status, resultRef ?? null, reviewRef ?? null, attemptId, expectedStatus);
    if (updated.changes !== 1) throw new Error("Work Ledger Attempt disappeared");
  }

  private programIdForTask(taskId: string): string {
    const task = this.db.query<{ program_id: string }, [string]>(`
      SELECT program_id FROM btcc_tasks WHERE task_id = ? AND is_active = 1
    `).get(taskId);
    if (!task) throw new Error("Work Ledger Task disappeared");
    return task.program_id;
  }

  private taskOwner(taskId: string): { programId: string; workId: string } {
    const task = this.db.query<{ program_id: string; work_id: string }, [string]>(`
      SELECT program_id, work_id FROM btcc_tasks WHERE task_id = ? AND is_active = 1
    `).get(taskId);
    if (!task) throw new Error("Work Ledger Task disappeared");
    return { programId: task.program_id, workId: task.work_id };
  }
}

function programIdOf(input: WorkLedgerCommit): string {
  const mutation = input.mutation;
  if (mutation.kind === "bind_program") return mutation.product.authority.managedBinding.programId;
  if (mutation.kind === "install_reviewed_plan") return mutation.product.candidate.programId;
  return mutation.cursor.programId;
}

function plannedAuthority(
  previous: ReturnType<SqliteWorkLedgerProgramReader["load"]>,
  input: WorkLedgerCommit,
) {
  if (input.mutation.kind === "bind_program") {
    return bindManagedProgram(previous, input.mutation, previous?.availableSpecs ?? []);
  }
  if (input.mutation.kind === "install_reviewed_plan") {
    if (!previous) throw new Error("Work Ledger reviewed Plan has no Program");
    return acceptReviewedPlanAuthority(previous, input.mutation.product);
  }
  if (input.mutation.kind === "accept_feedback_plan") {
    if (!previous) throw new Error("Work Ledger feedback Plan has no Program");
    return acceptFeedbackAuthority(previous, input.mutation.product);
  }
  return undefined;
}

function requireAuthority(
  authority: ReturnType<typeof plannedAuthority>,
) {
  if (!authority) throw new Error("Work Ledger mutation lacks planned authority");
  return authority;
}

function assertAuthorityProjection(
  actual: ManagedProgramAuthority,
  expected: ManagedProgramAuthority,
): void {
  const authority = (value: ManagedProgramAuthority) => ({
    ledgerId: value.ledgerId,
    programId: value.programId,
    manifestRevision: value.manifestRevision,
    goalContractRef: value.goalContractRef,
    authorityRef: value.authorityRef,
    availableSpecRefs: value.availableSpecRefs,
    availableSpecs: value.availableSpecs,
    governingSpecRefs: value.governingSpecRefs,
    requiredOutcomeId: value.requiredOutcomeId,
  });
  if (stableJson(authority(actual)) !== stableJson(authority(expected))) {
    throw new Error("Work Ledger authority projection changed after commit");
  }
}
