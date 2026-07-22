import type { Database } from "bun:sqlite";
import type {
  ProcessLiveness,
  RuntimeOwnerAuthority,
  RuntimeOwnerIdentity,
} from "./contracts.ts";

type OwnerRow = {
  owner_id: string;
  host_id: string;
  process_id: number;
  process_started_at_ms: number;
  owner_generation: number;
  status: "active" | "terminated" | "closed";
};

export class SqliteRuntimeOwnerRegistry implements RuntimeOwnerAuthority {
  readonly ownerId: string;
  readonly ownerGeneration: number;

  constructor(
    private readonly db: Database,
    private readonly identity: RuntimeOwnerIdentity,
    private readonly liveness: ProcessLiveness,
  ) {
    this.ownerId = identity.ownerId;
    this.ownerGeneration = this.register();
  }

  canAdoptClaimFrom(ownerId: string): boolean {
    if (ownerId === this.ownerId) return true;
    const owner = this.find(ownerId);
    if (!owner) {
      throw new Error(`BTCC claim owner has no durable runtime registration: ${ownerId}`);
    }
    if (owner.status !== "active") return true;
    if (this.liveness.isAlive(hydrateIdentity(owner))) return false;
    const terminated = this.db.query(`
      UPDATE btcc_runtime_owners SET status = 'terminated', closed_at = ?
      WHERE owner_id = ? AND owner_generation = ? AND status = 'active'
    `).run(new Date().toISOString(), owner.owner_id, owner.owner_generation);
    return terminated.changes === 1 || this.find(ownerId)?.status !== "active";
  }

  close(): void {
    this.db.query(`
      UPDATE btcc_runtime_owners SET status = 'closed', closed_at = ?
      WHERE owner_id = ? AND owner_generation = ? AND status = 'active'
    `).run(new Date().toISOString(), this.ownerId, this.ownerGeneration);
  }

  private register(): number {
    return this.db.transaction(() => {
      const existing = this.find(this.ownerId);
      if (!existing) {
        this.insert(1);
        return 1;
      }
      if (existing.status === "active" && sameProcess(existing, this.identity)) {
        return existing.owner_generation;
      }
      if (existing.status === "active" && this.liveness.isAlive(hydrateIdentity(existing))) {
        throw new Error(`BTCC runtime owner is already active: ${this.ownerId}`);
      }
      const generation = existing.owner_generation + 1;
      const replaced = this.db.query(`
        UPDATE btcc_runtime_owners SET host_id = ?, process_id = ?,
          process_started_at_ms = ?, owner_generation = ?, status = 'active',
          registered_at = ?, closed_at = NULL
        WHERE owner_id = ? AND owner_generation = ?
      `).run(
        this.identity.hostId,
        this.identity.processId,
        this.identity.processStartedAtMs,
        generation,
        new Date().toISOString(),
        this.ownerId,
        existing.owner_generation,
      );
      if (replaced.changes !== 1) throw new Error("BTCC runtime owner registration raced");
      return generation;
    })() as number;
  }

  private insert(generation: number): void {
    this.db.query(`
      INSERT INTO btcc_runtime_owners (
        owner_id, host_id, process_id, process_started_at_ms,
        owner_generation, status, registered_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?)
    `).run(
      this.identity.ownerId,
      this.identity.hostId,
      this.identity.processId,
      this.identity.processStartedAtMs,
      generation,
      new Date().toISOString(),
    );
  }

  private find(ownerId: string): OwnerRow | null {
    return this.db.query<OwnerRow, [string]>(`
      SELECT owner_id, host_id, process_id, process_started_at_ms,
        owner_generation, status
      FROM btcc_runtime_owners WHERE owner_id = ?
    `).get(ownerId) ?? null;
  }
}

function sameProcess(row: OwnerRow, identity: RuntimeOwnerIdentity): boolean {
  return row.host_id === identity.hostId &&
    row.process_id === identity.processId &&
    row.process_started_at_ms === identity.processStartedAtMs;
}

function hydrateIdentity(row: OwnerRow): RuntimeOwnerIdentity {
  return {
    ownerId: row.owner_id,
    hostId: row.host_id,
    processId: row.process_id,
    processStartedAtMs: row.process_started_at_ms,
  };
}
