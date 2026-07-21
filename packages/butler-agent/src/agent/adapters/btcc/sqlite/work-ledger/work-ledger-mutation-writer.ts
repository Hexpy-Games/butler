import type { Database } from "bun:sqlite";
import type {
  WorkLedgerCommit,
} from "../../../../btcc/index.ts";
import { stableJson } from "../identity.ts";
import { WorkLedgerCommitJournal } from "./work-ledger-commit-journal.ts";

export class SqliteWorkLedgerMutationWriter {
  private readonly journal: WorkLedgerCommitJournal;

  constructor(private readonly db: Database) {
    this.journal = new WorkLedgerCommitJournal(db);
  }

  commitAtomically(input: WorkLedgerCommit): void {
    this.db.transaction(() => {
      const boundary = this.journal.open(input);
      if (boundary.kind === "replayed") return;
      this.apply(input);
      this.journal.close(input, boundary.baseRevision);
    })();
  }

  private apply(input: WorkLedgerCommit): void {
    const mutation = input.mutation;
    switch (mutation.kind) {
      case "bind_program":
        this.bindProgram(mutation);
        return;
      case "install_reviewed_plan":
        this.installReviewedPlan(mutation.product);
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
      case "accept_implementation_repair":
        this.acceptRepair(mutation.product);
        return;
      case "close_implementation_frontier":
        this.closeFrontier(mutation.cursor.programId);
        return;
    }
  }

  private bindProgram(
    mutation: Extract<WorkLedgerCommit["mutation"], { kind: "bind_program" }>,
  ): void {
    const authority = mutation.product.authority;
    const binding = authority.managedBinding;
    const scopeId = authority.ledgerScope.kind === "project"
      ? authority.ledgerScope.projectRef
      : authority.ledgerScope.sessionId;
    this.db.query(`
      INSERT INTO btcc_programs (
        program_id, ledger_id, scope_kind, scope_id, session_id,
        goal_contract_ref, authority_ref, frontier, manifest_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unplanned', 1)
    `).run(
      binding.programId,
      binding.ledgerId,
      authority.ledgerScope.kind,
      scopeId,
      mutation.sessionId,
      mutation.product.goalContract.ref.id,
      authority.ref.id,
    );
  }

  private installReviewedPlan(
    product: Extract<WorkLedgerCommit["mutation"], {
      kind: "install_reviewed_plan";
    }>["product"],
  ): void {
    const candidate = product.candidate;
    const activated = this.db.query(`
      UPDATE btcc_programs SET accepted_plan_ref = ?, planning_review_ref = ?,
        frontier = 'implementation_open', manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND frontier = 'unplanned' AND manifest_revision = ?
    `).run(
      candidate.plan.ref.id,
      product.review.ref.id,
      candidate.programId,
      candidate.observedManifestRevision,
    );
    if (activated.changes !== 1) throw new Error("Work Ledger Plan base changed");
    const insertWork = this.db.query(`
      INSERT INTO btcc_work_items (work_id, program_id, work_ref, status)
      VALUES (?, ?, ?, 'planned')
    `);
    for (const work of candidate.works) {
      insertWork.run(work.ref.id, candidate.programId, stableJson(work.ref));
    }
    const workRefs = new Map(candidate.works.map((work) => [work.workLogicalId, work.ref]));
    const insertTask = this.db.query(`
      INSERT INTO btcc_tasks (task_id, program_id, work_id, task_ref, status)
      VALUES (?, ?, ?, ?, 'planned')
    `);
    for (const task of candidate.tasks) {
      const workRef = workRefs.get(task.workLogicalId);
      if (!workRef) throw new Error("Reviewed Task has no Work");
      insertTask.run(task.ref.id, candidate.programId, workRef.id, stableJson(task.ref));
    }
  }

  private selectAttempt(
    programId: string,
    attempt: Extract<WorkLedgerCommit["mutation"], { kind: "select_attempt" }>["attempt"],
  ): void {
    const task = this.db.query<{ work_id: string }, [string, string]>(`
      SELECT work_id FROM btcc_tasks WHERE program_id = ? AND task_id = ? AND status = 'planned'
    `).get(programId, attempt.taskRef.id);
    if (!task) throw new Error("Work Ledger selected Task is not planned");
    this.db.query(`
      INSERT INTO btcc_attempts (
        attempt_id, program_id, task_id, attempt_ref, previous_attempt_id,
        correction_plan_ref, execution_target_ref, execution_target_binding_ref, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready')
    `).run(
      attempt.ref.id,
      programId,
      attempt.taskRef.id,
      stableJson(attempt.ref),
      attempt.previousAttemptRef?.id ?? null,
      attempt.correctionPlanRef?.id ?? null,
      stableJson(attempt.executionTargetRef),
      stableJson(attempt.executionTargetBinding.ref),
    );
    this.db.query("UPDATE btcc_work_items SET status = 'active' WHERE work_id = ?")
      .run(task.work_id);
    this.db.query(`
      UPDATE btcc_tasks SET status = 'selected', current_attempt_id = ? WHERE task_id = ?
    `).run(attempt.ref.id, attempt.taskRef.id);
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
      UPDATE btcc_tasks SET status = ?, review_ref = ?
      WHERE task_id = ? AND current_attempt_id = ? AND status = 'result_submitted'
    `).run(
      status,
      product.review.ref.id,
      product.review.taskRef.id,
      product.review.attemptRef.id,
    );
    if (updated.changes !== 1) throw new Error("Work Ledger Review lost its submitted Task");
    const task = this.taskOwner(product.review.taskRef.id);
    if (status === "accepted") {
      this.db.query(`
        UPDATE btcc_work_items SET status = 'closed'
        WHERE work_id = ? AND NOT EXISTS (
          SELECT 1 FROM btcc_tasks WHERE work_id = ? AND status != 'accepted'
        )
      `).run(task.workId, task.workId);
    }
    this.bumpManifest(task.programId);
  }

  private acceptRepair(
    product: Extract<WorkLedgerCommit["mutation"], {
      kind: "accept_implementation_repair";
    }>["product"],
  ): void {
    const taskId = product.candidate.correctionPlan.targetTaskRef.id;
    const task = this.db.query<{ program_id: string; current_attempt_id: string }, [string]>(`
      SELECT program_id, current_attempt_id FROM btcc_tasks
      WHERE task_id = ? AND status = 'review_failed'
    `).get(taskId);
    if (!task) throw new Error("Implementation repair requires the failed current Task");
    const closed = this.db.query(`
      UPDATE btcc_attempts SET status = 'closed_unaccepted'
      WHERE attempt_id = ? AND status = 'review_failed'
    `).run(task.current_attempt_id);
    if (closed.changes !== 1) throw new Error("Implementation repair lost its failed Attempt");
    this.db.query("UPDATE btcc_tasks SET status = 'planned' WHERE task_id = ?").run(taskId);
    this.db.query(`
      UPDATE btcc_programs SET pending_correction_plan_ref = ? WHERE program_id = ?
    `).run(product.candidate.correctionPlan.ref.id, task.program_id);
    this.bumpManifest(task.program_id);
  }

  private closeFrontier(programId: string): void {
    const closed = this.db.query(`
      UPDATE btcc_programs SET frontier = 'closed',
        manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND frontier = 'implementation_open'
        AND NOT EXISTS (
          SELECT 1 FROM btcc_tasks WHERE program_id = ? AND status != 'accepted'
        )
    `).run(programId, programId);
    if (closed.changes !== 1) throw new Error("Work Ledger frontier changed");
    this.db.query("UPDATE btcc_work_items SET status = 'closed' WHERE program_id = ?")
      .run(programId);
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
      SELECT program_id FROM btcc_tasks WHERE task_id = ?
    `).get(taskId);
    if (!task) throw new Error("Work Ledger Task disappeared");
    return task.program_id;
  }

  private taskOwner(taskId: string): { programId: string; workId: string } {
    const task = this.db.query<{ program_id: string; work_id: string }, [string]>(`
      SELECT program_id, work_id FROM btcc_tasks WHERE task_id = ?
    `).get(taskId);
    if (!task) throw new Error("Work Ledger Task disappeared");
    return { programId: task.program_id, workId: task.work_id };
  }
}
