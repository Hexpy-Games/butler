import type { Database } from "bun:sqlite";
import type { WorkLedgerCommit } from "../../../btcc/gateway-api.ts";

type BindMutation = Extract<WorkLedgerCommit["mutation"], { kind: "bind_program" }>;
type CancellationMutation = Extract<WorkLedgerCommit["mutation"], { kind: "cancel_program" }>;

export class StoppedContinuationRegistry {
  constructor(private readonly db: Database) {}

  consumeBinding(
    binding: BindMutation["product"]["authority"]["managedBinding"],
    acceptAlreadyBound = false,
  ): void {
    const continuation = binding.continuationBinding;
    if (continuation.kind !== "stopped_program") return;
    const consumed = this.db.query(`
      UPDATE btcc_stopped_program_continuations SET status = 'bound'
      WHERE candidate_id = ? AND program_id = ? AND source_turn_id = ?
        AND anchor_id = ? AND expected_manifest_revision = ?
        AND base_manifest_hash = ? AND status = 'eligible'
    `).run(
      continuation.candidateId,
      binding.programId,
      continuation.sourceTurnId,
      continuation.anchorRef.id,
      binding.expectedManifestRevision,
      continuation.baseManifestHash,
    );
    if (consumed.changes === 1) return;
    if (acceptAlreadyBound && this.status(continuation.candidateId) === "bound") return;
    throw new Error("Stopped continuation candidate changed");
  }

  consumeCancellation(
    mutation: CancellationMutation,
    acceptAlreadyCancelled = false,
  ): void {
    const consumed = this.db.query(`
      UPDATE btcc_stopped_program_continuations SET status = 'cancelled'
      WHERE candidate_id = ? AND program_id = ? AND source_turn_id = ?
        AND expected_manifest_revision = ? AND base_manifest_hash = ?
        AND status = 'eligible'
    `).run(
      mutation.continuationCandidateId,
      mutation.cursor.programId,
      mutation.cancellation.sourceTurnId,
      mutation.cursor.expectedManifestRevision,
      mutation.baseManifestHash,
    );
    if (consumed.changes === 1) return;
    if (acceptAlreadyCancelled &&
      this.status(mutation.continuationCandidateId) === "cancelled") return;
    throw new Error("Work cancellation candidate changed");
  }

  private status(candidateId: string): string | undefined {
    return this.db.query<{ status: string }, [string]>(`
      SELECT status FROM btcc_stopped_program_continuations WHERE candidate_id = ?
    `).get(candidateId)?.status;
  }
}
