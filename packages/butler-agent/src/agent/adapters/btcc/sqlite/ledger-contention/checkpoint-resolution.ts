import type { Database } from "bun:sqlite";
import { digest } from "../identity.ts";

export type ContendedCheckpoint = {
  contention_id: string;
  checkpoint_id: string;
  checkpoint_revision: number;
};

export class LedgerContentionCheckpointResolution {
  constructor(private readonly db: Database) {}

  adoptPendingSubmission(row: ContendedCheckpoint): void {
    const closed = this.db.query(`
      UPDATE btcc_ledger_contentions SET status = 'closed'
      WHERE contention_id = ? AND status = 'owned'
    `).run(row.contention_id);
    if (closed.changes !== 1 && this.status(row.contention_id) !== "closed") {
      throw new Error("Ledger contention adoption lost durable ownership");
    }
  }

  supersedePendingSubmission(row: ContendedCheckpoint): void {
    this.db.transaction(() => {
      if (this.status(row.contention_id) === "closed") return;
      const checkpoint = this.db.query<{
        checkpoint_revision: number;
        active_claim_id: string | null;
      }, [string]>(`
        SELECT checkpoint_revision, active_claim_id FROM btcc_checkpoints
        WHERE checkpoint_id = ? AND is_active = 1
      `).get(row.checkpoint_id);
      if (!checkpoint || checkpoint.checkpoint_revision !== row.checkpoint_revision ||
        checkpoint.active_claim_id !== null) {
        throw new Error("Contended checkpoint lost its exact relinquished revision");
      }
      const claim = this.db.query<{
        claim_id: string;
        execution_fence: number;
      }, [string, number]>(`
        SELECT claim_id, execution_fence FROM btcc_state_claims
        WHERE checkpoint_id = ? AND checkpoint_revision = ? AND status = 'relinquished'
      `).get(row.checkpoint_id, row.checkpoint_revision);
      if (!claim) throw new Error("Contended checkpoint lost its relinquished State claim");
      const nextRevision = row.checkpoint_revision + 1;
      this.db.query(`
        INSERT INTO btcc_phase_checkpoint_revisions (
          checkpoint_id, checkpoint_revision, previous_revision_ref,
          state_claim_id, execution_fence, status
        ) VALUES (?, ?, ?, ?, ?, 'superseded_by_ledger_contention')
      `).run(
        row.checkpoint_id,
        nextRevision,
        digest(`btcc-phase-checkpoint-revision.v1\0${row.checkpoint_id}\0${row.checkpoint_revision}`),
        claim.claim_id,
        claim.execution_fence,
      );
      const checkpointUpdate = this.db.query(`
        UPDATE btcc_checkpoints SET checkpoint_revision = ?, accepted_product_json = NULL,
          actual_identity_json = NULL, active_claim_id = NULL
        WHERE checkpoint_id = ? AND checkpoint_revision = ? AND is_active = 1
          AND active_claim_id IS NULL
      `).run(nextRevision, row.checkpoint_id, row.checkpoint_revision);
      if (checkpointUpdate.changes !== 1) {
        throw new Error("Ledger contention checkpoint supersession lost its CAS");
      }
      const claimUpdate = this.db.query(`
        UPDATE btcc_state_claims SET checkpoint_revision = ?
        WHERE claim_id = ? AND checkpoint_revision = ? AND execution_fence = ?
          AND status = 'relinquished'
      `).run(nextRevision, claim.claim_id, row.checkpoint_revision, claim.execution_fence);
      if (claimUpdate.changes !== 1) {
        throw new Error("Ledger contention State claim supersession lost its CAS");
      }
      const closed = this.db.query(`
        UPDATE btcc_ledger_contentions SET status = 'closed'
        WHERE contention_id = ? AND checkpoint_revision = ? AND status = 'owned'
      `).run(row.contention_id, row.checkpoint_revision);
      if (closed.changes !== 1) {
        throw new Error("Ledger contention supersession lost durable ownership");
      }
    })();
  }

  private status(contentionId: string): string | undefined {
    return this.db.query<{ status: string }, [string]>(`
      SELECT status FROM btcc_ledger_contentions WHERE contention_id = ?
    `).get(contentionId)?.status;
  }
}
