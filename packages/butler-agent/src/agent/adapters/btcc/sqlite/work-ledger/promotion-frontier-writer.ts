import type { Database } from "bun:sqlite";
import type { WorkLedgerCommit } from "../../../../btcc/gateway-api.ts";
import { stableJson } from "../identity.ts";

type CloseImplementation = Extract<WorkLedgerCommit["mutation"], {
  kind: "close_implementation_frontier";
}>;
type ClosePromotion = Extract<WorkLedgerCommit["mutation"], {
  kind: "close_promotion_frontier";
}>;
type DeferPromotion = Extract<WorkLedgerCommit["mutation"], {
  kind: "accept_promotion_deferral";
}>;
type CloseDeferredPromotion = Extract<WorkLedgerCommit["mutation"], {
  kind: "close_deferred_promotion_frontier";
}>;

export class SqlitePromotionFrontierWriter {
  constructor(private readonly db: Database) {}

  closeImplementation(mutation: CloseImplementation): void {
    const programId = mutation.cursor.programId;
    const hasPromotion = this.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM btcc_tasks
      WHERE program_id = ? AND is_active = 1
        AND task_kind = 'repository_promotion'
    `).get(programId)!.count > 0;
    if (
      hasPromotion !== Boolean(mutation.promotionPermit) ||
      hasPromotion !== (mutation.promotionAssemblies.length > 0)
    ) {
      throw new Error("Work Ledger promotion permit does not match the reviewed graph");
    }
    const assemblyRefs = mutation.promotionAssemblies.map((assembly) => ({
      candidateRef: assembly.candidate.ref,
      resolutionRef: assembly.resolution.ref,
    }));
    const closed = this.db.query(`
      UPDATE btcc_programs SET promotion_assembly_refs_json = ?,
        promotion_permit_ref = ?, frontier = ?,
        manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND frontier = 'implementation_open'
        AND manifest_revision = ?
        AND NOT EXISTS (
          SELECT 1 FROM btcc_tasks
          WHERE program_id = ? AND is_active = 1
            AND task_kind != 'repository_promotion' AND status != 'accepted'
        )
    `).run(
      stableJson(assemblyRefs),
      mutation.promotionPermit?.ref.id ?? null,
      hasPromotion ? "promotion_open" : "closed",
      programId,
      mutation.cursor.expectedManifestRevision,
      programId,
    );
    if (closed.changes !== 1) throw new Error("Work Ledger frontier changed");
    this.db.query(`
      UPDATE btcc_work_items SET status = CASE
        WHEN EXISTS (
          SELECT 1 FROM btcc_tasks
          WHERE btcc_tasks.work_id = btcc_work_items.work_id
            AND btcc_tasks.is_active = 1
            AND btcc_tasks.task_kind = 'repository_promotion'
        ) THEN 'active' ELSE 'closed' END
      WHERE program_id = ?
    `).run(programId);
  }

  close(mutation: ClosePromotion): void {
    const cursor = mutation.cursor;
    const updated = this.db.query(`
      UPDATE btcc_programs SET frontier = 'closed',
        manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND frontier = 'promotion_open'
        AND manifest_revision = ?
        AND NOT EXISTS (
          SELECT 1 FROM btcc_tasks
          WHERE program_id = ? AND is_active = 1 AND status != 'accepted'
        )
    `).run(cursor.programId, cursor.expectedManifestRevision, cursor.programId);
    if (updated.changes !== 1) throw new Error("Promotion frontier is not complete");
    this.db.query("UPDATE btcc_work_items SET status = 'closed' WHERE program_id = ?")
      .run(cursor.programId);
  }

  defer(mutation: DeferPromotion): void {
    const product = mutation.product;
    const task = this.db.query<{ current_attempt_id: string }, [string, string]>(`
      SELECT current_attempt_id FROM btcc_tasks
      WHERE program_id = ? AND task_id = ? AND status = 'selected' AND is_active = 1
    `).get(mutation.cursor.programId, product.deferral.promotionTaskRef.id);
    if (!task || task.current_attempt_id !== product.deferral.attemptRef.id) {
      throw new Error("Promotion deferral lost its selected Attempt");
    }
    this.db.query(`
      UPDATE btcc_attempts SET status = 'promotion_deferred'
      WHERE attempt_id = ? AND status = 'ready'
    `).run(product.deferral.attemptRef.id);
    const updatedTask = this.db.query(`
      UPDATE btcc_tasks SET status = 'promotion_deferred'
      WHERE task_id = ? AND status = 'selected'
    `).run(product.deferral.promotionTaskRef.id);
    if (updatedTask.changes !== 1) throw new Error("Promotion deferral lost its Task");
    const updatedProgram = this.db.query(`
      UPDATE btcc_programs SET active_deferral_ref = ?, active_deferral_turn_id = ?,
        promotion_deferral_ref = ?,
        manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND frontier = 'promotion_open'
        AND promotion_permit_ref = ? AND manifest_revision = ?
    `).run(
      product.anchor.ref.id,
      product.anchor.sourceTurnId,
      product.deferral.ref.id,
      mutation.cursor.programId,
      product.deferral.authorizationRef.id,
      mutation.cursor.expectedManifestRevision,
    );
    if (updatedProgram.changes !== 1) throw new Error("Promotion deferral base changed");
  }

  closeDeferred(mutation: CloseDeferredPromotion): void {
    const updated = this.db.query(`
      UPDATE btcc_programs SET frontier = 'closed',
        manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND frontier = 'promotion_open'
        AND manifest_revision = ? AND active_deferral_ref = ?
        AND promotion_deferral_ref IS NOT NULL
    `).run(
      mutation.cursor.programId,
      mutation.cursor.expectedManifestRevision,
      mutation.deferredAnchorRef.id,
    );
    if (updated.changes !== 1) throw new Error("Deferred promotion frontier changed");
  }
}
