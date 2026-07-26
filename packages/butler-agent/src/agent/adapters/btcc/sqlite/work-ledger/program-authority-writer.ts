import type { Database } from "bun:sqlite";
import type {
  ManagedProgramAuthority,
  WorkLedgerCommit,
} from "../../../../btcc/gateway-api.ts";
import { stableJson } from "../identity.ts";
import { SqliteContinuedPlanWriter } from "./continued-plan-writer.ts";
import { StoppedContinuationRegistry } from "../stopped-continuation-registry.ts";

type BindProgram = Extract<WorkLedgerCommit["mutation"], { kind: "bind_program" }>;
type InstallPlan = Extract<WorkLedgerCommit["mutation"], { kind: "install_reviewed_plan" }>;

export class SqliteProgramAuthorityWriter {
  private readonly continuedPlans: SqliteContinuedPlanWriter;
  private readonly stoppedContinuations: StoppedContinuationRegistry;

  constructor(private readonly db: Database) {
    this.continuedPlans = new SqliteContinuedPlanWriter(db);
    this.stoppedContinuations = new StoppedContinuationRegistry(db);
  }

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
    if (binding.source === "stopped_program") {
      this.bindStoppedProgram(mutation, scopeId, projection);
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

  private bindStoppedProgram(
    mutation: BindProgram,
    scopeId: string,
    projection: ManagedProgramAuthority,
  ): void {
    const authority = mutation.product.authority;
    const binding = authority.managedBinding;
    if (binding.continuationBinding.kind !== "stopped_program") {
      throw new Error("Stopped Program binding lacks its continuation provenance");
    }
    const rebound = this.db.query(`
      UPDATE btcc_programs SET goal_contract_ref = ?, authority_ref = ?,
        available_specs_json = ?, governing_spec_refs_json = ?,
        manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND ledger_id = ? AND scope_kind = ? AND scope_id = ?
        AND manifest_revision = ? AND active_deferral_ref IS NULL
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
    );
    if (rebound.changes !== 1) throw new Error("Stopped Program binding changed");
    this.stoppedContinuations.consumeBinding(binding);
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
      this.continuedPlans.install(product, {
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

}
