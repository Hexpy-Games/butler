import type { Database } from "bun:sqlite";
import type { WorkLedgerCommit } from "../../../../btcc/index.ts";

type FeedbackProduct = Extract<
  WorkLedgerCommit["mutation"],
  { kind: "accept_feedback_plan" }
>["product"];

export class SqliteImplementationRepairWriter {
  constructor(private readonly db: Database) {}

  accept(product: FeedbackProduct): void {
    const targets = product.candidate.correctionPlan.targetTaskRefs;
    const decisions = product.candidate.correctionPlan.findingDecisions;
    const requiresExecution = decisions.length === 0 ||
      decisions.some((decision) => decision.decision === "apply_now");
    const programIds = new Set(targets.map((target) =>
      requiresExecution
        ? this.reopenForExecution(target.id)
        : this.reopenForReview(target.id)));
    if (programIds.size !== 1) throw new Error("Implementation repair crossed Program authority");
    const programId = [...programIds][0]!;
    this.db.query(`
      UPDATE btcc_programs SET pending_correction_plan_ref = ?, frontier = 'implementation_open'
      WHERE program_id = ?
    `).run(product.candidate.correctionPlan.ref.id, programId);
    this.bumpManifest(programId);
  }

  closeDisposition(programId: string): void {
    this.db.query(`
      UPDATE btcc_programs SET pending_correction_plan_ref = NULL
      WHERE program_id = ? AND pending_correction_plan_ref IS NOT NULL
    `).run(programId);
  }

  private reopenForReview(taskId: string): string {
    const task = this.db.query<{
      program_id: string;
      work_id: string;
      current_attempt_id: string | null;
    }, [string]>(`
      SELECT program_id, work_id, current_attempt_id FROM btcc_tasks
      WHERE task_id = ? AND status = 'review_failed' AND is_active = 1
    `).get(taskId);
    if (!task?.current_attempt_id) {
      throw new Error("Finding disposition target has no failed Review");
    }
    const attempt = this.db.query(`
      UPDATE btcc_attempts SET status = 'result_submitted'
      WHERE attempt_id = ? AND status = 'review_failed'
    `).run(task.current_attempt_id);
    if (attempt.changes !== 1) {
      throw new Error("Finding disposition lost its failed Attempt");
    }
    const current = this.db.query(`
      UPDATE btcc_tasks SET status = 'result_submitted'
      WHERE task_id = ? AND status = 'review_failed'
    `).run(taskId);
    if (current.changes !== 1) {
      throw new Error("Finding disposition lost its failed Task");
    }
    this.db.query("UPDATE btcc_work_items SET status = 'active' WHERE work_id = ?")
      .run(task.work_id);
    return task.program_id;
  }

  private reopenForExecution(taskId: string): string {
    const task = this.db.query<{
      program_id: string;
      work_id: string;
      current_attempt_id: string | null;
      status: string;
    }, [string]>(`
      SELECT program_id, work_id, current_attempt_id, status FROM btcc_tasks
      WHERE task_id = ? AND status IN ('review_failed', 'accepted') AND is_active = 1
    `).get(taskId);
    if (!task) throw new Error("Implementation repair target is not reviewable");
    if (task.status === "review_failed") {
      const closed = this.db.query(`
        UPDATE btcc_attempts SET status = 'closed_unaccepted'
        WHERE attempt_id = ? AND status = 'review_failed'
      `).run(task.current_attempt_id);
      if (closed.changes !== 1) throw new Error("Implementation repair lost its failed Attempt");
    }
    this.db.query(`
      UPDATE btcc_tasks SET status = 'planned', current_attempt_id = NULL,
        result_ref = NULL, review_ref = NULL WHERE task_id = ?
    `).run(taskId);
    this.db.query("UPDATE btcc_work_items SET status = 'planned' WHERE work_id = ?")
      .run(task.work_id);
    return task.program_id;
  }

  private bumpManifest(programId: string): void {
    const result = this.db.query(`
      UPDATE btcc_programs SET manifest_revision = manifest_revision + 1 WHERE program_id = ?
    `).run(programId);
    if (result.changes !== 1) throw new Error("Work Ledger Program disappeared");
  }
}
