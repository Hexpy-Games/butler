import type { Database } from "bun:sqlite";
import type {
  OperationalCheckpointAnchor,
  OperationalRecoveryReceipt,
  OperationalRecoveryStore,
} from "../../../btcc/index.ts";
import { OperationalInterruptionError } from "../../../btcc/index.ts";

type ReceiptRow = { interruption_id: string; activation_count: number };
type InterruptionRow = {
  code: string;
  activation_kind: OperationalInterruptionError["activation"]["kind"];
  status: "interrupted" | "ready";
};

export class SqliteOperationalRecoveryStore implements OperationalRecoveryStore {
  constructor(private readonly db: Database) {}

  async record(
    interruption: OperationalInterruptionError,
  ): Promise<OperationalRecoveryReceipt> {
    const anchor = interruption.anchor;
    this.db.query(`
      INSERT INTO btcc_operational_interruptions (
        interruption_id, turn_id, turn_revision, semantic_state,
        checkpoint_id, checkpoint_revision, claim_id, execution_fence,
        code, activation_kind, diagnostic_message,
        activation_count, status, interrupted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'interrupted', ?)
      ON CONFLICT(claim_id, code, activation_kind) DO UPDATE SET
        activation_count = CASE WHEN status = 'interrupted'
          THEN activation_count ELSE activation_count + 1 END,
        diagnostic_message = excluded.diagnostic_message,
        status = 'interrupted', interrupted_at = excluded.interrupted_at,
        resolved_at = NULL
    `).run(
      interruptionId(interruption),
      anchor.turnId,
      anchor.turnRevision,
      anchor.semanticState,
      anchor.checkpointId,
      anchor.checkpointRevision,
      anchor.claimId,
      anchor.executionFence,
      interruption.code,
      interruption.activation.kind,
      diagnosticMessage(interruption),
      new Date().toISOString(),
    );
    const row = this.db.query<ReceiptRow, [string, string, string]>(`
      SELECT interruption_id, activation_count
      FROM btcc_operational_interruptions
      WHERE claim_id = ? AND code = ? AND activation_kind = ?
    `).get(anchor.claimId, interruption.code, interruption.activation.kind);
    if (!row) throw new Error("BTCC operational interruption was not persisted");
    return {
      interruptionId: row.interruption_id,
      activationCount: row.activation_count,
    };
  }

  async markReady(receipt: OperationalRecoveryReceipt): Promise<void> {
    this.db.query(`
      UPDATE btcc_operational_interruptions SET status = 'ready'
      WHERE interruption_id = ? AND status = 'interrupted'
    `).run(receipt.interruptionId);
  }

  async pending(
    anchor: OperationalCheckpointAnchor,
  ) {
    const row = this.db.query<InterruptionRow, [string, string, number, string, number, number]>(`
      SELECT code, activation_kind, status FROM btcc_operational_interruptions
      WHERE claim_id = ? AND turn_id = ? AND turn_revision = ?
        AND checkpoint_id = ? AND checkpoint_revision = ?
        AND execution_fence = ? AND status IN ('interrupted', 'ready')
      ORDER BY interrupted_at DESC LIMIT 1
    `).get(
      anchor.claimId,
      anchor.turnId,
      anchor.turnRevision,
      anchor.checkpointId,
      anchor.checkpointRevision,
      anchor.executionFence,
    );
    return row ? {
      interruption: new OperationalInterruptionError(
        row.code,
        anchor,
        { kind: row.activation_kind },
      ),
      status: row.status,
    } : null;
  }

  async resolve(anchor: OperationalCheckpointAnchor): Promise<boolean> {
    const result = this.db.query(`
      UPDATE btcc_operational_interruptions
      SET status = 'resolved', resolved_at = ?
      WHERE claim_id = ? AND turn_id = ? AND turn_revision = ?
        AND checkpoint_id = ? AND checkpoint_revision = ?
        AND execution_fence = ? AND status IN ('interrupted', 'ready')
    `).run(
      new Date().toISOString(),
      anchor.claimId,
      anchor.turnId,
      anchor.turnRevision,
      anchor.checkpointId,
      anchor.checkpointRevision,
      anchor.executionFence,
    );
    return result.changes > 0;
  }

  async pendingTurnIds(): Promise<string[]> {
    return this.db.query<{ turn_id: string }, []>(`
      SELECT DISTINCT interruption.turn_id
      FROM btcc_operational_interruptions interruption
      JOIN btcc_state_claims claim ON claim.claim_id = interruption.claim_id
      JOIN btcc_turns turn ON turn.turn_id = interruption.turn_id
      WHERE interruption.status IN ('interrupted', 'ready') AND claim.status = 'active'
        AND turn.semantic_state NOT IN ('delivered', 'cancelled')
      ORDER BY interruption.interrupted_at
    `).all().map((row) => row.turn_id);
  }
}

function diagnosticMessage(interruption: OperationalInterruptionError): string | null {
  const cause = interruption.cause;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return cause === undefined ? null : String(cause);
}

function interruptionId(interruption: OperationalInterruptionError): string {
  return [
    "operational",
    interruption.anchor.claimId,
    interruption.code,
    interruption.activation.kind,
  ].join(":");
}
