import type { Database } from "bun:sqlite";
import type { BtccPersistenceTypes } from "../../../btcc/index.ts";
import { stableJson } from "./identity.ts";

type GoalContractAcceptedProduct = BtccPersistenceTypes["goalContractAcceptedProduct"];
type ResultCandidateProduct = BtccPersistenceTypes["resultCandidateProduct"];
type PlanningAcceptedProduct = BtccPersistenceTypes["planningAcceptedProduct"];
type TaskReviewProduct = BtccPersistenceTypes["taskReviewProduct"];
type ManagedProgramState = BtccPersistenceTypes["managedProgramState"];
type ManagedAttempt = BtccPersistenceTypes["managedAttempt"];

export class SqliteManagedLedgerWriter {
  constructor(private readonly db: Database) {}

  createProgram(sessionId: string, product: GoalContractAcceptedProduct): void {
    const { goalContract, authority } = product;
    const binding = authority.managedBinding;
    this.db.query(`
      INSERT INTO btcc_programs (
        program_id, ledger_id, session_id, goal_contract_ref, authority_ref,
        frontier, manifest_revision
      ) VALUES (?, ?, ?, ?, ?, 'unplanned', 1)
    `).run(
      binding.programId, binding.ledgerId, sessionId,
      goalContract.ref.id, authority.ref.id,
    );
  }

  activatePlan(product: PlanningAcceptedProduct): void {
    const candidate = product.candidate;
    this.db.query(`
      UPDATE btcc_programs SET accepted_plan_ref = ?, planning_review_ref = ?,
        frontier = 'implementation_open', manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND frontier = 'unplanned'
    `).run(candidate.plan.ref.id, product.review.ref.id, candidate.programId);
    this.db.query(`
      INSERT INTO btcc_work_items (work_id, program_id, work_ref, status)
      VALUES (?, ?, ?, 'planned')
    `).run(candidate.work.ref.id, candidate.programId, stableJson(candidate.work.ref));
    this.db.query(`
      INSERT INTO btcc_tasks (task_id, program_id, work_id, task_ref, status)
      VALUES (?, ?, ?, ?, 'planned')
    `).run(
      candidate.task.ref.id, candidate.programId, candidate.work.ref.id,
      stableJson(candidate.task.ref),
    );
  }

  selectAttempt(program: ManagedProgramState, attempt: ManagedAttempt): void {
    this.db.query(`
      INSERT INTO btcc_attempts (
        attempt_id, program_id, task_id, attempt_ref, previous_attempt_id,
        correction_plan_ref, execution_target_ref, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready')
    `).run(
      attempt.ref.id, program.programId, program.task.ref.id, stableJson(attempt.ref),
      attempt.previousAttemptRef?.id ?? null, attempt.correctionPlanRef?.id ?? null,
      stableJson(attempt.executionTargetRef),
    );
    this.db.query("UPDATE btcc_work_items SET status = 'active' WHERE work_id = ?")
      .run(program.work.ref.id);
    this.db.query(`
      UPDATE btcc_tasks SET status = 'selected', current_attempt_id = ? WHERE task_id = ?
    `).run(attempt.ref.id, program.task.ref.id);
  }

  submitResult(program: ManagedProgramState, result: ResultCandidateProduct): void {
    this.updateCurrentAttempt(program, "result_submitted", result.result.ref.id);
    this.db.query(`
      UPDATE btcc_tasks SET status = 'result_submitted', result_ref = ? WHERE task_id = ?
    `).run(result.result.ref.id, program.task.ref.id);
  }

  recordReview(program: ManagedProgramState, review: TaskReviewProduct): void {
    const status = review.review.verdict === "passed" ? "accepted" : "review_failed";
    this.updateCurrentAttempt(program, status, undefined, review.review.ref.id);
    this.db.query(`
      UPDATE btcc_tasks SET status = ?, review_ref = ? WHERE task_id = ?
    `).run(status, review.review.ref.id, program.task.ref.id);
  }

  acceptImplementationRepair(program: ManagedProgramState): void {
    const previous = program.attempts.at(-1);
    if (!previous || previous.status !== "review_failed") {
      throw new Error("Implementation repair requires the failed current Attempt");
    }
    this.db.query("UPDATE btcc_attempts SET status = 'closed_unaccepted' WHERE attempt_id = ?")
      .run(previous.ref.id);
    this.db.query("UPDATE btcc_tasks SET status = 'planned' WHERE task_id = ?")
      .run(program.task.ref.id);
  }

  closeFrontier(program: ManagedProgramState): void {
    this.db.query(`
      UPDATE btcc_programs SET frontier = 'closed',
        manifest_revision = manifest_revision + 1 WHERE program_id = ?
    `).run(program.programId);
    this.db.query("UPDATE btcc_work_items SET status = 'closed' WHERE work_id = ?")
      .run(program.work.ref.id);
  }

  private updateCurrentAttempt(
    program: ManagedProgramState,
    status: string,
    resultRef?: string,
    reviewRef?: string,
  ): void {
    const attempt = program.attempts.at(-1);
    if (!attempt) throw new Error("Managed Program has no current Attempt");
    this.db.query(`
      UPDATE btcc_attempts SET status = ?, result_ref = COALESCE(?, result_ref),
        review_ref = COALESCE(?, review_ref) WHERE attempt_id = ?
    `).run(status, resultRef ?? null, reviewRef ?? null, attempt.ref.id);
  }
}
