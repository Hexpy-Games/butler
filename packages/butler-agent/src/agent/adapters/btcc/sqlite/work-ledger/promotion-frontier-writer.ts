import type { Database } from "bun:sqlite";
import type { WorkLedgerCommit } from "../../../../btcc/index.ts";
import { stableJson } from "../identity.ts";

type CloseImplementation = Extract<WorkLedgerCommit["mutation"], {
  kind: "close_implementation_frontier";
}>;
type AuthorizePromotion = Extract<WorkLedgerCommit["mutation"], {
  kind: "authorize_promotion";
}>;
type ClosePromotion = Extract<WorkLedgerCommit["mutation"], {
  kind: "close_promotion_frontier";
}>;

export class SqlitePromotionFrontierWriter {
  constructor(private readonly db: Database) {}

  closeImplementation(mutation: CloseImplementation): void {
    const programId = mutation.cursor.programId;
    const assemblyRefs = mutation.promotionAssemblies.map((assembly) => ({
      candidateRef: assembly.candidate.ref,
      resolutionRef: assembly.resolution.ref,
    }));
    const closed = this.db.query(`
      UPDATE btcc_programs SET promotion_assembly_refs_json = ?, frontier = CASE
          WHEN EXISTS (
            SELECT 1 FROM btcc_tasks
            WHERE program_id = ? AND is_active = 1
              AND task_kind = 'repository_promotion'
          ) THEN 'awaiting_consolidation'
          ELSE 'closed'
        END,
        manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND frontier = 'implementation_open'
        AND NOT EXISTS (
          SELECT 1 FROM btcc_tasks
          WHERE program_id = ? AND is_active = 1
            AND task_kind != 'repository_promotion' AND status != 'accepted'
        )
    `).run(stableJson(assemblyRefs), programId, programId, programId);
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

  authorize(mutation: AuthorizePromotion): void {
    const updated = this.db.query(`
      UPDATE btcc_programs SET frontier = 'promotion_open',
        promotion_authorization_ref = ?, manifest_revision = manifest_revision + 1
      WHERE program_id = ? AND frontier = 'awaiting_consolidation'
        AND manifest_revision = ?
    `).run(
      mutation.product.authorization.ref.id,
      mutation.cursor.programId,
      mutation.cursor.expectedManifestRevision,
    );
    if (updated.changes !== 1) throw new Error("Promotion authorization lost its frontier");
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
}
