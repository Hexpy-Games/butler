import type { Database } from "bun:sqlite";
import type { TurnStateRepository } from
  "../../../btcc/turn/index.ts";
import { digest } from "./identity.ts";
import type { RuntimeOwnerAuthority } from "./runtime-owner/index.ts";

type TurnRepository = TurnStateRepository;
type Turn = NonNullable<Awaited<ReturnType<TurnRepository["findTurn"]>>>;
type Claim = Awaited<ReturnType<TurnRepository["acquireStateExecutionClaim"]>>;
type ClaimRow = {
  owner_id: string;
  owner_generation: number;
  lease_generation: number;
  checkpoint_revision: number;
  execution_fence: number;
  status: string;
};

export class SqliteStateExecutionClaims {
  constructor(
    private readonly db: Database,
    private readonly owner: RuntimeOwnerAuthority,
  ) {}

  acquire(turn: Turn): Claim {
    if (!turn.checkpoint) throw new Error("Nonterminal BTCC Turn has no active checkpoint");
    const checkpoint = turn.checkpoint;
    const claimId = digest(
      `btcc-state-claim.v1\0${turn.turnId}\0${turn.revision}\0${turn.semanticState}\0${checkpoint.checkpointId}`,
    );
    this.db.transaction(() => {
      this.assertExactTurn(turn, checkpoint.checkpointId);
      this.db.query(`
        INSERT OR IGNORE INTO btcc_state_claims (
          claim_id, turn_id, turn_revision, semantic_state, checkpoint_id,
          checkpoint_revision, execution_fence, owner_id, owner_generation,
          lease_generation, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active')
      `).run(
        claimId, turn.turnId, turn.revision, turn.semanticState,
        checkpoint.checkpointId, checkpoint.checkpointRevision, turn.executionFence,
        this.owner.ownerId, this.owner.ownerGeneration,
      );
      const current = this.find(claimId);
      if (!current) throw new Error("BTCC state claim was not persisted");
      if (current.status === "relinquished" || !this.isCurrentOwner(current)) {
        this.adopt(claimId, current, checkpoint.checkpointRevision);
      }
      const claimed = this.find(claimId);
      if (!claimed || !this.isCurrentOwner(claimed) || claimed.status !== "active" ||
        claimed.checkpoint_revision !== checkpoint.checkpointRevision ||
        claimed.execution_fence !== turn.executionFence) {
        throw new Error("BTCC state is not actively owned by this runtime");
      }
      const activated = this.db.query(`
        UPDATE btcc_checkpoints SET active_claim_id = ?
        WHERE checkpoint_id = ? AND checkpoint_revision = ? AND is_active = 1
          AND (active_claim_id IS NULL OR active_claim_id = ?)
      `).run(claimId, checkpoint.checkpointId, checkpoint.checkpointRevision, claimId);
      if (activated.changes !== 1) {
        throw new Error("BTCC checkpoint is already claimed by another runtime");
      }
    })();
    return {
      claimId,
      turnId: turn.turnId,
      turnRevision: turn.revision,
      semanticState: turn.semanticState,
      checkpointId: checkpoint.checkpointId,
      checkpointRevision: checkpoint.checkpointRevision,
      executionFence: turn.executionFence,
    };
  }

  private adopt(claimId: string, claim: ClaimRow, checkpointRevision: number): void {
    if (claim.status !== "relinquished" &&
      !this.owner.canAdoptClaimFrom(claim.owner_id)) {
      throw new Error("BTCC state is actively owned by another live runtime");
    }
    const adopted = this.db.query(`
      UPDATE btcc_state_claims SET status = 'active', owner_id = ?,
        owner_generation = ?, lease_generation = lease_generation + 1
      WHERE claim_id = ? AND owner_id = ? AND owner_generation = ?
        AND lease_generation = ? AND checkpoint_revision = ?
        AND execution_fence = ? AND status = ?
    `).run(
      this.owner.ownerId, this.owner.ownerGeneration, claimId, claim.owner_id,
      claim.owner_generation, claim.lease_generation, checkpointRevision,
      claim.execution_fence, claim.status,
    );
    if (adopted.changes !== 1) throw new Error("BTCC state claim adoption raced");
  }

  private isCurrentOwner(claim: ClaimRow): boolean {
    return claim.owner_id === this.owner.ownerId &&
      claim.owner_generation === this.owner.ownerGeneration;
  }

  private find(claimId: string): ClaimRow | null {
    return this.db.query<ClaimRow, [string]>(`
      SELECT owner_id, owner_generation, lease_generation, checkpoint_revision,
        execution_fence, status FROM btcc_state_claims WHERE claim_id = ?
    `).get(claimId) ?? null;
  }

  private assertExactTurn(turn: Turn, checkpointId: string): void {
    const current = this.db.query<{
      semantic_state: string;
      revision: number;
      execution_fence: number;
      active_checkpoint_id: string;
    }, [string]>(`
      SELECT semantic_state, revision, execution_fence, active_checkpoint_id
      FROM btcc_turns WHERE turn_id = ?
    `).get(turn.turnId);
    if (!current || current.semantic_state !== turn.semanticState ||
      current.revision !== turn.revision || current.execution_fence !== turn.executionFence ||
      current.active_checkpoint_id !== checkpointId) {
      throw new Error("BTCC StateExecutionClaim lost its exact Turn revision");
    }
  }
}
