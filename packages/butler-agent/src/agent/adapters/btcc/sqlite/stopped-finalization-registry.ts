import type { Database } from "bun:sqlite";
import type {
  ContinuationBinding,
  FinalizationContinuation,
  GoalContractRecord,
} from "../../../btcc/gateway-api.ts";
import {
  assertStoppedFinalizationInput,
  loadStoppedFinalizationGoalContract,
  type StoppedFinalizationRow,
} from "./stopped-finalization-authority.ts";
import { digest, stableJson } from "./identity.ts";

type FinalizationBinding = Extract<ContinuationBinding, {
  kind: "stopped_finalization";
}>;

export class StoppedFinalizationRegistry {
  constructor(private readonly db: Database) {}

  consume(
    binding: FinalizationBinding,
    finalization: FinalizationContinuation,
    turnId: string,
  ): GoalContractRecord {
    const row = this.requireExactRow(binding);
    assertStoppedFinalizationInput(this.db, row, finalization);
    const originalGoal = loadStoppedFinalizationGoalContract(
      this.db,
      binding.originalGoalContractRef,
    );
    const consumed = this.db.query(`
      UPDATE btcc_stopped_finalization_continuations
      SET status = 'bound', bound_turn_id = ?
      WHERE candidate_id = ? AND program_id = ? AND source_turn_id = ?
        AND anchor_id = ? AND anchor_sha256 = ? AND blocker_id = ? AND blocker_sha256 = ?
        AND goal_contract_ref = ? AND resume_at = ? AND expected_manifest_revision = ?
        AND base_manifest_hash = ? AND status = 'eligible'
    `).run(
      turnId,
      binding.candidateId,
      binding.programId,
      binding.sourceTurnId,
      binding.anchorRef.id,
      binding.anchorRef.sha256,
      row.blocker_id,
      row.blocker_sha256,
      binding.originalGoalContractRef.id,
      binding.context.finalization.resumeAt,
      binding.expectedManifestRevision,
      binding.baseManifestHash,
    );
    if (consumed.changes === 1) return originalGoal;
    if (this.boundTurn(binding.candidateId) === turnId) return originalGoal;
    throw new Error("Stopped finalization continuation changed");
  }

  private requireExactRow(binding: FinalizationBinding): StoppedFinalizationRow {
    const row = this.db.query<StoppedFinalizationRow, [string]>(`
      SELECT candidate_id, anchor_id, anchor_sha256, blocker_id, blocker_sha256,
        source_turn_id, ledger_id, program_id, expected_manifest_revision,
        base_manifest_hash, goal_contract_ref, resume_at
      FROM btcc_stopped_finalization_continuations WHERE candidate_id = ?
    `).get(binding.candidateId);
    if (!row || row.anchor_id !== binding.anchorRef.id ||
      row.anchor_sha256 !== binding.anchorRef.sha256 ||
      row.source_turn_id !== binding.sourceTurnId || row.ledger_id !== binding.ledgerId ||
      row.program_id !== binding.programId ||
      row.expected_manifest_revision !== binding.expectedManifestRevision ||
      row.base_manifest_hash !== binding.baseManifestHash ||
      row.goal_contract_ref !== binding.originalGoalContractRef.id ||
      row.resume_at !== binding.context.finalization.resumeAt) {
      throw new Error("Stopped finalization continuation changed");
    }
    const identity = {
      continuationKind: "managed_finalization" as const,
      ledgerId: row.ledger_id,
      programId: row.program_id,
      expectedManifestRevision: row.expected_manifest_revision,
      baseManifestHash: row.base_manifest_hash,
      sourceTurnId: row.source_turn_id,
      originalGoalContractRef: binding.originalGoalContractRef,
      anchorRef: { id: row.anchor_id, sha256: row.anchor_sha256 },
      blockerRef: { id: row.blocker_id, sha256: row.blocker_sha256 },
    };
    const candidateId = digest(`btcc-continuation-candidate.v1\0${stableJson(identity)}`);
    if (candidateId !== binding.candidateId) {
      throw new Error("Stopped finalization candidate identity changed");
    }
    return row;
  }

  private boundTurn(candidateId: string): string | undefined {
    return this.db.query<{ bound_turn_id: string | null }, [string]>(`
      SELECT bound_turn_id FROM btcc_stopped_finalization_continuations
      WHERE candidate_id = ?
    `).get(candidateId)?.bound_turn_id ?? undefined;
  }
}
