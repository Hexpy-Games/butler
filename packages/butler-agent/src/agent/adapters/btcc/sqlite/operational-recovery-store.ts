import type { Database } from "bun:sqlite";
import type {
  OperationalCheckpointAnchor,
  OperationalRecoveryReceipt,
  OperationalRecoveryStore,
} from "../../../btcc/gateway-api.ts";
import {
  decodeOperationalDiagnostic,
  OperationalInterruptionError,
} from "../../../btcc/gateway-api.ts";
import type { OperationalDiagnostic } from "../../../btcc/gateway-api.ts";
import { stableJson } from "./identity.ts";

type ReceiptRow = { interruption_id: string; activation_count: number };
type InterruptionRow = {
  code: string;
  activation_kind: OperationalInterruptionError["activation"]["kind"];
  retry_at: string | null;
  diagnostic_message: string | null;
  diagnostic_json: string | null;
  status: "interrupted" | "ready";
};

export class SqliteOperationalRecoveryStore implements OperationalRecoveryStore {
  constructor(private readonly db: Database) {
    this.reconcileLegacyRateLimits();
    this.closeInterruptionsWhoseClaimsCompleted();
  }

  async record(
    interruption: OperationalInterruptionError,
  ): Promise<OperationalRecoveryReceipt> {
    const anchor = interruption.anchor;
    this.db.query(`
      INSERT INTO btcc_operational_interruptions (
        interruption_id, turn_id, turn_revision, semantic_state,
        checkpoint_id, checkpoint_revision, claim_id, execution_fence,
        code, activation_kind, retry_at, diagnostic_message, diagnostic_json,
        activation_count, status, interrupted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'interrupted', ?)
      ON CONFLICT(claim_id, code, activation_kind) DO UPDATE SET
        activation_count = CASE WHEN status = 'interrupted'
          THEN activation_count ELSE activation_count + 1 END,
        turn_revision = excluded.turn_revision,
        semantic_state = excluded.semantic_state,
        checkpoint_id = excluded.checkpoint_id,
        checkpoint_revision = excluded.checkpoint_revision,
        execution_fence = excluded.execution_fence,
        retry_at = excluded.retry_at,
        diagnostic_message = excluded.diagnostic_message,
        diagnostic_json = excluded.diagnostic_json,
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
      interruption.activation.kind === "automatic_provider_recovery"
        ? interruption.activation.retryAt ?? null
        : null,
      diagnosticMessage(interruption),
      persistedDiagnostic(interruption.diagnostic),
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

  async activateInheritedRuntimeRemediations(): Promise<void> {
    this.db.query(`
      UPDATE btcc_operational_interruptions
      SET status = 'ready'
      WHERE status = 'interrupted' AND activation_kind = 'runtime_remediation'
        AND EXISTS (
          SELECT 1 FROM btcc_state_claims claim
          JOIN btcc_turns turn ON turn.turn_id = btcc_operational_interruptions.turn_id
          WHERE claim.claim_id = btcc_operational_interruptions.claim_id
            AND claim.status = 'active'
            AND turn.semantic_state NOT IN ('delivered', 'cancelled')
        )
    `).run();
  }

  async pending(
    anchor: OperationalCheckpointAnchor,
  ) {
    const row = this.db.query<InterruptionRow, [string, string, number, string, number, number]>(`
      SELECT code, activation_kind, retry_at, diagnostic_message,
        diagnostic_json, status
      FROM btcc_operational_interruptions
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
        row.activation_kind === "automatic_provider_recovery" && row.retry_at
          ? { kind: row.activation_kind, retryAt: row.retry_at }
          : { kind: row.activation_kind },
        row.diagnostic_message ? new Error(row.diagnostic_message) : undefined,
        operationalDiagnostic(row.diagnostic_json),
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

  private closeInterruptionsWhoseClaimsCompleted(): void {
    this.db.query(`
      UPDATE btcc_operational_interruptions
      SET status = 'resolved', resolved_at = COALESCE(resolved_at, ?)
      WHERE status IN ('interrupted', 'ready') AND EXISTS (
        SELECT 1 FROM btcc_state_claims claim
        WHERE claim.claim_id = btcc_operational_interruptions.claim_id
          AND claim.status = 'consumed'
      )
    `).run(new Date().toISOString());
  }

  private reconcileLegacyRateLimits(): void {
    this.db.exec(`
      DELETE FROM btcc_operational_interruptions AS stale
      WHERE stale.code = 'provider_rate_limited'
        AND stale.activation_kind = 'automatic_provider_recovery'
        AND stale.retry_at IS NULL
        AND EXISTS (
          SELECT 1 FROM btcc_operational_interruptions AS parked
          WHERE parked.claim_id = stale.claim_id
            AND parked.code = stale.code
            AND parked.activation_kind = 'provider_action_required'
        );
      UPDATE btcc_operational_interruptions
      SET activation_kind = 'provider_action_required'
      WHERE code = 'provider_rate_limited'
        AND activation_kind = 'automatic_provider_recovery'
        AND retry_at IS NULL;
    `);
  }
}

function diagnosticMessage(interruption: OperationalInterruptionError): string | null {
  if (interruption.code.startsWith("provider_") ||
    interruption.diagnostic?.kind === "provider_request") return null;
  const cause = interruption.cause;
  if (cause instanceof Error) return cause.message;
  return cause === undefined ? null : String(cause);
}

function operationalDiagnostic(value: string | null): OperationalDiagnostic | undefined {
  return decodeOperationalDiagnostic(value);
}

function persistedDiagnostic(value: OperationalDiagnostic | undefined): string | null {
  const diagnostic = decodeOperationalDiagnostic(value);
  return diagnostic ? stableJson(diagnostic) : null;
}

function interruptionId(interruption: OperationalInterruptionError): string {
  return [
    "operational",
    interruption.anchor.claimId,
    interruption.code,
    interruption.activation.kind,
  ].join(":");
}
