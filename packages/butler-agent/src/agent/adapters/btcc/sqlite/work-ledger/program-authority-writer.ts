import type { Database } from "bun:sqlite";
import type {
  ManagedProgramAuthority,
  WorkLedgerCommit,
} from "../../../../btcc/gateway-api.ts";
import { stableJson } from "../identity.ts";

type BindProgram = Extract<WorkLedgerCommit["mutation"], { kind: "bind_program" }>;
type InstallPlan = Extract<WorkLedgerCommit["mutation"], { kind: "install_reviewed_plan" }>;

export class SqliteProgramAuthorityWriter {
  constructor(private readonly db: Database) {}

  bindProgram(
    mutation: BindProgram,
    projection: ManagedProgramAuthority,
  ): void {
    const authority = mutation.product.authority;
    if (authority.ledgerScope.kind !== "session") {
      throw new Error("Session Work Ledger received a Project-bound Program");
    }
    const binding = authority.managedBinding;
    const scopeId = authority.ledgerScope.sessionId;
    if (binding.source === "deferred_goal") {
      this.bindDeferredProgram(mutation, scopeId, projection);
      return;
    }
    this.db.query(`
      INSERT INTO btcc_programs (
        program_id, ledger_id, scope_kind, scope_id, session_id,
        goal_contract_ref, authority_ref, frontier, manifest_revision,
        available_specs_json, governing_spec_refs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unplanned', 1, ?, ?)
    `).run(
      binding.programId,
      binding.ledgerId,
      authority.ledgerScope.kind,
      scopeId,
      mutation.sessionId,
      mutation.product.goalContract.ref.id,
      authority.ref.id,
      stableJson(projection.availableSpecs),
      stableJson(projection.governingSpecRefs),
    );
  }

  installReviewedPlan(
    product: InstallPlan["product"],
    projection: ManagedProgramAuthority,
  ): void {
    const candidate = product.candidate;
    const expectedAnchor = candidate.revisionOrigin.kind === "deferred_continuation"
      ? candidate.revisionOrigin.deferredAnchorRef.id
      : null;
    const current = this.db.query<{
      active_deferral_ref: string | null;
      accepted_plan_ref: string | null;
      promotion_permit_ref: string | null;
    }, [string]>(`
      SELECT active_deferral_ref, accepted_plan_ref, promotion_permit_ref
      FROM btcc_programs WHERE program_id = ?
    `).get(candidate.programId);
    if (!current || current.active_deferral_ref !== expectedAnchor) {
      throw new Error("Reviewed Plan continuation anchor changed");
    }
    if (current.accepted_plan_ref) {
      this.continueReviewedPlan(product, {
        acceptedPlanRef: current.accepted_plan_ref,
        promotionPermitted: current.promotion_permit_ref !== null,
      }, projection);
      return;
    }
    this.activateFirstPlan(product, projection);
  }

  private bindDeferredProgram(
    mutation: BindProgram,
    scopeId: string,
    projection: ManagedProgramAuthority,
  ): void {
    const authority = mutation.product.authority;
    const binding = authority.managedBinding;
    const continuation = binding.continuationBinding;
    if (continuation.kind !== "deferred_goal") {
      throw new Error("Deferred Program binding lacks its continuation provenance");
    }
    const rebound = this.db.query(`
      UPDATE btcc_programs SET goal_contract_ref = ?, authority_ref = ?,
        available_specs_json = ?, governing_spec_refs_json = ?,
        manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND ledger_id = ? AND scope_kind = ? AND scope_id = ?
        AND manifest_revision = ? AND active_deferral_ref = ?
        AND active_deferral_turn_id = ?
    `).run(
      mutation.product.goalContract.ref.id,
      authority.ref.id,
      stableJson(projection.availableSpecs),
      stableJson(projection.governingSpecRefs),
      binding.programId,
      binding.ledgerId,
      authority.ledgerScope.kind,
      scopeId,
      binding.expectedManifestRevision,
      continuation.anchorRef.id,
      continuation.sourceTurnId,
    );
    if (rebound.changes !== 1) throw new Error("Deferred Program binding changed");
  }

  private activateFirstPlan(
    product: InstallPlan["product"],
    projection: ManagedProgramAuthority,
  ): void {
    const candidate = product.candidate;
    const activated = this.db.query(`
      UPDATE btcc_programs SET accepted_plan_ref = ?, accepted_plan_candidate_ref = ?,
        planning_review_ref = ?,
        frontier = 'implementation_open', active_deferral_ref = NULL,
        active_deferral_turn_id = NULL, promotion_deferral_ref = NULL,
        available_specs_json = ?, governing_spec_refs_json = ?,
        manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND frontier = 'unplanned' AND manifest_revision = ?
    `).run(
      candidate.plan.ref.id,
      candidate.ref.id,
      product.review.ref.id,
      stableJson(projection.availableSpecs),
      stableJson(projection.governingSpecRefs),
      candidate.programId,
      candidate.observedManifestRevision,
    );
    if (activated.changes !== 1) throw new Error("Work Ledger Plan base changed");
    this.insertWorksAndTasks(product);
  }

  private insertWorksAndTasks(product: InstallPlan["product"]): void {
    const candidate = product.candidate;
    const insertWork = this.db.query(`
      INSERT INTO btcc_work_items (work_id, program_id, work_ref, status)
      VALUES (?, ?, ?, 'planned')
    `);
    for (const work of candidate.works) {
      insertWork.run(work.ref.id, candidate.programId, stableJson(work.ref));
    }
    const workRefs = new Map(candidate.works.map((work) => [work.workLogicalId, work.ref]));
    const insertTask = this.db.query(`
      INSERT INTO btcc_tasks (
        task_id, program_id, work_id, task_ref, task_kind, status
      ) VALUES (?, ?, ?, ?, ?, 'planned')
    `);
    for (const task of candidate.tasks) {
      const workRef = workRefs.get(task.workLogicalId);
      if (!workRef) throw new Error("Reviewed Task has no Work");
      insertTask.run(
        task.ref.id,
        candidate.programId,
        workRef.id,
        stableJson(task.ref),
        task.artifactPolicy.kind,
      );
    }
  }

  private continueReviewedPlan(
    product: InstallPlan["product"],
    current: { acceptedPlanRef: string; promotionPermitted: boolean },
    projection: ManagedProgramAuthority,
  ): void {
    const candidate = product.candidate;
    if (candidate.revisionOrigin.kind !== "deferred_continuation") {
      throw new Error("Deferred continuation lost its reviewed anchor");
    }
    if (candidate.plan.ref.id !== current.acceptedPlanRef) {
      this.replaceContinuedPlan(product, projection);
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
    if (continued.changes !== 1) throw new Error("Deferred continuation base changed");
  }

  private replaceContinuedPlan(
    product: InstallPlan["product"],
    projection: ManagedProgramAuthority,
  ): void {
    const candidate = product.candidate;
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
    this.installContinuedWorks(product);
    this.installContinuedTasks(product);
    this.synchronizeContinuedWorks(candidate.programId);
  }

  private installContinuedWorks(product: InstallPlan["product"]): void {
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

  private installContinuedTasks(product: InstallPlan["product"]): void {
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

  private synchronizeContinuedWorks(programId: string): void {
    this.db.query(`
      UPDATE btcc_work_items SET status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM btcc_tasks WHERE btcc_tasks.work_id = btcc_work_items.work_id
            AND btcc_tasks.is_active = 1 AND btcc_tasks.status != 'accepted'
        ) THEN 'closed' ELSE 'planned' END
      WHERE program_id = ? AND is_active = 1
    `).run(programId);
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
