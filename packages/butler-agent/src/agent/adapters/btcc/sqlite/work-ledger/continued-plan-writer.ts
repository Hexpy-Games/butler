import type { Database } from "bun:sqlite";
import type {
  ManagedProgramAuthority,
  WorkLedgerCommit,
} from "../../../../btcc/gateway-api.ts";
import { stableJson } from "../identity.ts";

type InstallPlan = Extract<WorkLedgerCommit["mutation"], { kind: "install_reviewed_plan" }>;
type CurrentPlan = { acceptedPlanRef: string; promotionPermitted: boolean };
type CompletedTask = { taskId: string; workId: string; workLogicalId: string };

export class SqliteContinuedPlanWriter {
  constructor(private readonly db: Database) {}

  install(
    product: InstallPlan["product"],
    current: CurrentPlan,
    projection: ManagedProgramAuthority,
  ): void {
    const candidate = product.candidate;
    if (
      candidate.revisionOrigin.kind !== "deferred_continuation" &&
      candidate.revisionOrigin.kind !== "stopped_continuation"
    ) {
      throw new Error("Program continuation lost its reviewed anchor");
    }
    if (candidate.plan.ref.id !== current.acceptedPlanRef) {
      this.replace(product, projection);
      return;
    }
    this.closeUnacceptedAttempts(candidate.programId);
    this.reopenUnacceptedTasks(candidate.programId);
    const continued = this.db.query(`
      UPDATE btcc_programs SET planning_review_ref = ?, frontier = ?,
        active_deferral_ref = NULL, active_deferral_turn_id = NULL,
        promotion_deferral_ref = NULL, available_specs_json = ?,
        governing_spec_refs_json = ?, manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND manifest_revision = ?
    `).run(
      product.review.ref.id,
      current.promotionPermitted ? "promotion_open" : "implementation_open",
      stableJson(projection.availableSpecs),
      stableJson(projection.governingSpecRefs),
      candidate.programId,
      candidate.observedManifestRevision,
    );
    if (continued.changes !== 1) throw new Error("Continuation Plan base changed");
  }

  private replace(
    product: InstallPlan["product"],
    projection: ManagedProgramAuthority,
  ): void {
    const candidate = product.candidate;
    const completed = this.activeAcceptedTasks(candidate.programId);
    this.closeUnacceptedAttempts(candidate.programId);
    const replaced = this.db.query(`
      UPDATE btcc_programs SET accepted_plan_ref = ?, accepted_plan_candidate_ref = ?,
        planning_review_ref = ?,
        frontier = 'implementation_open', promotion_permit_ref = NULL,
        promotion_assembly_refs_json = NULL, active_deferral_ref = NULL,
        active_deferral_turn_id = NULL, promotion_deferral_ref = NULL,
        available_specs_json = ?, governing_spec_refs_json = ?,
        manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND manifest_revision = ?
    `).run(
      candidate.plan.ref.id,
      candidate.ref.id,
      product.review.ref.id,
      stableJson(projection.availableSpecs),
      stableJson(projection.governingSpecRefs),
      candidate.programId,
      candidate.observedManifestRevision,
    );
    if (replaced.changes !== 1) throw new Error("Continued Plan revision lost its manifest base");
    this.db.query("UPDATE btcc_work_items SET is_active = 0 WHERE program_id = ?")
      .run(candidate.programId);
    this.db.query("UPDATE btcc_tasks SET is_active = 0 WHERE program_id = ?")
      .run(candidate.programId);
    this.installWorks(product);
    this.installTasks(product);
    this.retainCompletedTasks(product, completed);
    this.synchronizeWorks(candidate.programId);
  }

  private activeAcceptedTasks(programId: string): CompletedTask[] {
    const rows = this.db.query<{
      task_id: string;
      work_id: string;
      content_json: string;
    }, [string]>(`
      SELECT t.task_id, t.work_id, r.content_json
      FROM btcc_tasks t JOIN btcc_records r ON r.record_id = t.task_id
      WHERE t.program_id = ? AND t.is_active = 1 AND t.status = 'accepted'
    `).all(programId);
    return rows.map((row) => ({
      taskId: row.task_id,
      workId: row.work_id,
      workLogicalId: (JSON.parse(row.content_json) as { workLogicalId: string }).workLogicalId,
    }));
  }

  private retainCompletedTasks(
    product: InstallPlan["product"],
    completed: CompletedTask[],
  ): void {
    const candidateTaskIds = new Set(product.candidate.tasks.map((task) => task.ref.id));
    const candidateWorkIds = new Map(product.candidate.works
      .map((work) => [work.workLogicalId, work.ref.id]));
    for (const task of completed) {
      if (candidateTaskIds.has(task.taskId)) continue;
      const replacementWorkId = candidateWorkIds.get(task.workLogicalId);
      if (!replacementWorkId) {
        this.db.query("UPDATE btcc_work_items SET is_active = 1 WHERE work_id = ?")
          .run(task.workId);
      }
      this.db.query(`
        UPDATE btcc_tasks SET work_id = ?, is_active = 1 WHERE task_id = ?
      `).run(replacementWorkId ?? task.workId, task.taskId);
    }
  }

  private installWorks(product: InstallPlan["product"]): void {
    for (const work of product.candidate.works) {
      const restored = this.db.query(`
        UPDATE btcc_work_items SET is_active = 1 WHERE work_id = ? AND program_id = ?
      `).run(work.ref.id, product.candidate.programId);
      if (restored.changes === 0) {
        this.db.query(`
          INSERT INTO btcc_work_items (work_id, program_id, work_ref, status, is_active)
          VALUES (?, ?, ?, 'planned', 1)
        `).run(work.ref.id, product.candidate.programId, stableJson(work.ref));
      }
    }
  }

  private installTasks(product: InstallPlan["product"]): void {
    const workRefs = new Map(product.candidate.works
      .map((work) => [work.workLogicalId, work.ref.id]));
    for (const task of product.candidate.tasks) {
      const workId = workRefs.get(task.workLogicalId);
      if (!workId) throw new Error("Continued Task has no reviewed Work");
      const restored = this.db.query(`
        UPDATE btcc_tasks SET work_id = ?, is_active = 1
        WHERE task_id = ? AND program_id = ?
      `).run(workId, task.ref.id, product.candidate.programId);
      if (restored.changes === 0) {
        this.db.query(`
          INSERT INTO btcc_tasks (
            task_id, program_id, work_id, task_ref, task_kind, status, is_active
          ) VALUES (?, ?, ?, ?, ?, 'planned', 1)
        `).run(
          task.ref.id,
          product.candidate.programId,
          workId,
          stableJson(task.ref),
          task.artifactPolicy.kind,
        );
      }
    }
  }

  private closeUnacceptedAttempts(programId: string): void {
    this.db.query(`
      UPDATE btcc_attempts SET status = 'closed_unaccepted'
      WHERE program_id = ? AND status != 'accepted'
    `).run(programId);
  }

  private reopenUnacceptedTasks(programId: string): void {
    this.db.query(`
      UPDATE btcc_tasks SET status = CASE
          WHEN status = 'accepted' THEN 'accepted' ELSE 'planned' END,
        current_attempt_id = CASE WHEN status = 'accepted' THEN current_attempt_id ELSE NULL END,
        result_ref = CASE WHEN status = 'accepted' THEN result_ref ELSE NULL END,
        review_ref = CASE WHEN status = 'accepted' THEN review_ref ELSE NULL END
      WHERE program_id = ? AND is_active = 1
    `).run(programId);
    this.synchronizeWorks(programId);
  }

  private synchronizeWorks(programId: string): void {
    this.db.query(`
      UPDATE btcc_work_items SET status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM btcc_tasks WHERE btcc_tasks.work_id = btcc_work_items.work_id
            AND btcc_tasks.is_active = 1 AND btcc_tasks.status != 'accepted'
        ) THEN 'closed' ELSE 'planned' END
      WHERE program_id = ? AND is_active = 1
    `).run(programId);
  }
}
