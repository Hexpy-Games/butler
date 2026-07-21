import type { Database } from "bun:sqlite";
import type { WorkLedgerCommit } from "../../../../btcc/index.ts";
import { stableJson } from "../identity.ts";

type FeedbackProduct = Extract<
  WorkLedgerCommit["mutation"],
  { kind: "accept_feedback_plan" }
>["product"];
type RevisedCandidate = Exclude<
  FeedbackProduct["candidate"],
  { correctionKind: "implementation_repair" }
>;
type RevisedPlan = RevisedCandidate["nextPlanCandidate"];
type TaskImpact = RevisedCandidate["impactMap"][number];

export class SqliteReviewedGraphInstaller {
  constructor(private readonly db: Database) {}

  install(product: FeedbackProduct): void {
    const candidate = product.candidate;
    if (candidate.correctionKind === "implementation_repair") {
      throw new Error("Graph installer received implementation repair");
    }
    const next = candidate.nextPlanCandidate;
    const updated = this.db.query(`
      UPDATE btcc_programs SET accepted_plan_ref = ?, planning_review_ref = ?,
        authority_ref = ?, frontier = 'implementation_open',
        pending_correction_plan_ref = ?, promotion_assembly_refs_json = NULL,
        manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND manifest_revision = ?
    `).run(
      next.plan.ref.id,
      product.review.ref.id,
      candidate.correctionKind === "authority_scope_revision"
        ? candidate.proposedAuthority.ref.id
        : next.authorityRef.id,
      candidate.correctionPlan.ref.id,
      next.programId,
      next.observedManifestRevision,
    );
    if (updated.changes !== 1) throw new Error("Governing revision lost its manifest base");
    this.deactivateCurrentGraph(next.programId);
    this.installWorks(next);
    this.installTasks(next, candidate.impactMap);
    this.synchronizeWorkStatuses(next.programId);
  }

  private deactivateCurrentGraph(programId: string): void {
    this.db.query("UPDATE btcc_work_items SET is_active = 0 WHERE program_id = ?")
      .run(programId);
    this.db.query("UPDATE btcc_tasks SET is_active = 0 WHERE program_id = ?")
      .run(programId);
  }

  private installWorks(candidate: RevisedPlan): void {
    for (const work of candidate.works) {
      const existing = this.db.query("SELECT work_id FROM btcc_work_items WHERE work_id = ?")
        .get(work.ref.id);
      if (existing) {
        this.db.query("UPDATE btcc_work_items SET is_active = 1 WHERE work_id = ?")
          .run(work.ref.id);
      } else {
        this.db.query(`
          INSERT INTO btcc_work_items (work_id, program_id, work_ref, status, is_active)
          VALUES (?, ?, ?, 'planned', 1)
        `).run(work.ref.id, candidate.programId, stableJson(work.ref));
      }
    }
  }

  private installTasks(candidate: RevisedPlan, impactMap: TaskImpact[]): void {
    const workRefs = new Map(candidate.works.map((work) => [work.workLogicalId, work.ref]));
    const impacts = new Map(impactMap
      .filter((impact) => impact.successorTaskRef)
      .map((impact) => [impact.successorTaskRef!.id, impact]));
    for (const task of candidate.tasks) {
      const workRef = workRefs.get(task.workLogicalId);
      if (!workRef) throw new Error("Revised Task has no Work");
      this.installTask(candidate.programId, workRef.id, task, impacts.get(task.ref.id));
    }
  }

  private installTask(
    programId: string,
    workId: string,
    task: RevisedPlan["tasks"][number],
    impact?: TaskImpact,
  ): void {
    const existing = this.db.query<{ status: string }, [string]>(
      "SELECT status FROM btcc_tasks WHERE task_id = ?",
    ).get(task.ref.id);
    const status = impact?.disposition === "unaffected" && existing
      ? existing.status
      : "planned";
    if (existing) {
      this.db.query(`
        UPDATE btcc_tasks SET work_id = ?, task_kind = ?, status = ?, is_active = 1,
          current_attempt_id = CASE WHEN ? = 'planned' THEN NULL ELSE current_attempt_id END,
          result_ref = CASE WHEN ? = 'planned' THEN NULL ELSE result_ref END,
          review_ref = CASE WHEN ? = 'planned' THEN NULL ELSE review_ref END
        WHERE task_id = ?
      `).run(
        workId,
        task.artifactPolicy.kind,
        status,
        status,
        status,
        status,
        task.ref.id,
      );
      return;
    }
    this.db.query(`
      INSERT INTO btcc_tasks (
        task_id, program_id, work_id, task_ref, task_kind, status, is_active
      ) VALUES (?, ?, ?, ?, ?, 'planned', 1)
    `).run(task.ref.id, programId, workId, stableJson(task.ref), task.artifactPolicy.kind);
  }

  private synchronizeWorkStatuses(programId: string): void {
    this.db.query(`
      UPDATE btcc_work_items
      SET status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM btcc_tasks
          WHERE btcc_tasks.work_id = btcc_work_items.work_id
            AND btcc_tasks.is_active = 1
            AND btcc_tasks.task_kind != 'repository_promotion'
            AND btcc_tasks.status != 'accepted'
        ) THEN 'closed'
        ELSE 'planned'
      END
      WHERE program_id = ? AND is_active = 1
    `).run(programId);
  }
}
