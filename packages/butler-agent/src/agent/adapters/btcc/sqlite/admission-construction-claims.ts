import type { Database } from "bun:sqlite";
import type { RuntimeOwnerAuthority } from "./runtime-owner/index.ts";
import { digest } from "./identity.ts";

type ClaimRow = {
  owner_id: string;
  owner_generation: number;
  lease_generation: number;
  status: string;
};

export class SqliteAdmissionConstructionClaims {
  constructor(
    private readonly db: Database,
    private readonly owner: RuntimeOwnerAuthority,
  ) {}

  acquire(inboxId: string): { claimId: string; inboxId: string } {
    const claimId = digest(`btcc-admission-claim.v1\0${inboxId}`);
    this.db.transaction(() => {
      this.db.query(`
        INSERT OR IGNORE INTO btcc_admission_claims (
          claim_id, inbox_id, owner_id, owner_generation, lease_generation, status
        ) VALUES (?, ?, ?, ?, 1, 'active')
      `).run(claimId, inboxId, this.owner.ownerId, this.owner.ownerGeneration);
      const current = this.find(claimId);
      if (!current) throw new Error("BTCC Admission claim was not persisted");
      if (!this.isCurrentOwner(current)) this.adopt(claimId, current);
      const claimed = this.find(claimId);
      if (!claimed || claimed.status !== "active" || !this.isCurrentOwner(claimed)) {
        throw new Error("BTCC Admission is not actively owned by this runtime");
      }
    })();
    return { claimId, inboxId };
  }

  private adopt(claimId: string, claim: ClaimRow): void {
    if (claim.status !== "relinquished" &&
      !this.owner.canAdoptClaimFrom(claim.owner_id)) {
      throw new Error("BTCC Admission is actively owned by another live runtime");
    }
    const adopted = this.db.query(`
      UPDATE btcc_admission_claims SET status = 'active', owner_id = ?,
        owner_generation = ?, lease_generation = lease_generation + 1
      WHERE claim_id = ? AND owner_id = ? AND owner_generation = ?
        AND lease_generation = ? AND status = ?
    `).run(
      this.owner.ownerId, this.owner.ownerGeneration, claimId, claim.owner_id,
      claim.owner_generation, claim.lease_generation, claim.status,
    );
    if (adopted.changes !== 1) throw new Error("BTCC Admission claim adoption raced");
  }

  private isCurrentOwner(claim: ClaimRow): boolean {
    return claim.owner_id === this.owner.ownerId &&
      claim.owner_generation === this.owner.ownerGeneration;
  }

  private find(claimId: string): ClaimRow | null {
    return this.db.query<ClaimRow, [string]>(`
      SELECT owner_id, owner_generation, lease_generation, status
      FROM btcc_admission_claims WHERE claim_id = ?
    `).get(claimId) ?? null;
  }
}
