import type { Database } from "bun:sqlite";
import type {
  GuidedEffectError,
  GuidedEffectIdentity,
  GuidedEffectJournal,
  GuidedEffectJournalRecord,
  GuidedEffectReceipt,
  PrepareGuidedEffectResult,
} from "../../../btcc/effects/index.ts";
import { SqliteGuidedEffectBlockerStore } from
  "./guided-effect-blocker-store.ts";
import {
  type GuidedEffectRow,
  hydrateGuidedEffect,
} from "./guided-effect-records.ts";

export class SqliteGuidedEffectJournal implements GuidedEffectJournal {
  private readonly blockers: SqliteGuidedEffectBlockerStore;

  constructor(private readonly db: Database) {
    this.blockers = new SqliteGuidedEffectBlockerStore(db);
  }

  prepare(identity: GuidedEffectIdentity): PrepareGuidedEffectResult {
    return this.db.transaction(() => {
      const existing = this.find(identity.effectId);
      if (existing) {
        return sameIdentity(existing, identity)
          ? { ok: true as const, created: false, record: existing }
          : conflict(identity.effectId);
      }
      const now = new Date().toISOString();
      this.db.query(`
        INSERT INTO btcc_guided_effects (
          effect_id, receipt_id, idempotency_key, identity_sha256,
          request_sha256, input_sha256, target_sha256, work_id,
          plan_revision_id, action_key, capability, sanitized_target,
          status, journal_revision, dispatch_attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 1, 0, ?, ?)
      `).run(
        identity.effectId,
        identity.receiptId,
        identity.idempotencyKey,
        identity.identitySha256,
        identity.requestSha256,
        identity.inputSha256,
        identity.targetSha256,
        identity.workId,
        identity.planRevisionId,
        identity.actionKey,
        identity.capability,
        identity.sanitizedTarget,
        now,
        now,
      );
      return {
        ok: true as const,
        created: true,
        record: this.required(identity.effectId),
      };
    })();
  }

  find(effectId: string): GuidedEffectJournalRecord | null {
    const row = this.db.query<GuidedEffectRow, [string]>(`
      SELECT effect_id, receipt_id, idempotency_key, identity_sha256,
        request_sha256, input_sha256, target_sha256, work_id,
        plan_revision_id, action_key, capability, sanitized_target,
        status, journal_revision, dispatch_attempts, result_json,
        receipt_json, error_json, created_at, updated_at
      FROM btcc_guided_effects WHERE effect_id = ?
    `).get(effectId);
    return row ? hydrateGuidedEffect(row) : null;
  }

  listForWork(workId: string, limit = 12): GuidedEffectJournalRecord[] {
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    return this.db.query<GuidedEffectRow, [string, number]>(`
      SELECT effect_id, receipt_id, idempotency_key, identity_sha256,
        request_sha256, input_sha256, target_sha256, work_id,
        plan_revision_id, action_key, capability, sanitized_target,
        status, journal_revision, dispatch_attempts, result_json,
        receipt_json, error_json, created_at, updated_at
      FROM btcc_guided_effects
      WHERE work_id = ?
      ORDER BY updated_at DESC, effect_id DESC
      LIMIT ?
    `).all(workId, boundedLimit).map(hydrateGuidedEffect);
  }

  listEffectBlockersForReconciliation(
    workId: string,
  ) {
    return this.blockers.listForReconciliation(workId);
  }

  resolveBlockerOccurrence(
    workId: string,
    sourceOccurrenceId: string,
    resolution: "applied" | "not_applied",
  ): boolean {
    return this.blockers.resolveOccurrence(
      workId,
      sourceOccurrenceId,
      resolution,
    );
  }

  claimDispatch(
    effectId: string,
    expectedJournalRevision: number,
  ): GuidedEffectJournalRecord | null {
    const updated = this.db.query(`
      UPDATE btcc_guided_effects SET status = 'dispatching',
        journal_revision = journal_revision + 1,
        dispatch_attempts = dispatch_attempts + 1,
        error_json = NULL, updated_at = ?
      WHERE effect_id = ? AND journal_revision = ?
        AND status IN ('prepared', 'dispatching', 'uncertain')
    `).run(new Date().toISOString(), effectId, expectedJournalRevision);
    return updated.changes === 1 ? this.required(effectId) : null;
  }

  returnToPrepared(
    effectId: string,
    expectedJournalRevision: number,
  ): GuidedEffectJournalRecord | null {
    return this.transition(
      effectId,
      expectedJournalRevision,
      "status = 'prepared', error_json = NULL",
      ["dispatching"],
    );
  }

  recordApplied<TResult>(
    effectId: string,
    expectedJournalRevision: number,
    result: TResult,
    receipt: GuidedEffectReceipt<TResult>,
  ): GuidedEffectJournalRecord | null {
    const current = this.find(effectId);
    if (!current || !receiptMatches(current, receipt)) return null;
    const resultJson = json(result, "effect result");
    if (json(receipt.result, "effect receipt result") !== resultJson) return null;
    const receiptJson = json(receipt, "effect receipt");
    const updated = this.db.query(`
      UPDATE btcc_guided_effects SET status = 'applied',
        journal_revision = journal_revision + 1, result_json = ?,
        receipt_json = ?, error_json = NULL, updated_at = ?, applied_at = ?
      WHERE effect_id = ? AND journal_revision = ?
        AND status IN ('prepared', 'dispatching', 'uncertain')
    `).run(
      resultJson,
      receiptJson,
      receipt.appliedAt,
      receipt.appliedAt,
      effectId,
      expectedJournalRevision,
    );
    return updated.changes === 1 ? this.required(effectId) : null;
  }

  recordUncertain(
    effectId: string,
    expectedJournalRevision: number,
    error: GuidedEffectError,
  ): GuidedEffectJournalRecord | null {
    return this.transition(
      effectId,
      expectedJournalRevision,
      "status = 'uncertain', error_json = ?",
      ["prepared", "dispatching", "uncertain"],
      json(error, "effect error"),
    );
  }

  recordFailed(
    effectId: string,
    expectedJournalRevision: number,
    error: GuidedEffectError,
  ): GuidedEffectJournalRecord | null {
    return this.transition(
      effectId,
      expectedJournalRevision,
      "status = 'failed', error_json = ?",
      ["dispatching"],
      json(error, "effect error"),
    );
  }

  private transition(
    effectId: string,
    expectedJournalRevision: number,
    assignment: string,
    statuses: string[],
    value?: string,
  ): GuidedEffectJournalRecord | null {
    const placeholders = statuses.map(() => "?").join(", ");
    const args = [
      ...(value === undefined ? [] : [value]),
      new Date().toISOString(),
      effectId,
      expectedJournalRevision,
      ...statuses,
    ];
    const updated = this.db.query(`
      UPDATE btcc_guided_effects SET ${assignment},
        journal_revision = journal_revision + 1, updated_at = ?
      WHERE effect_id = ? AND journal_revision = ?
        AND status IN (${placeholders})
    `).run(...args);
    return updated.changes === 1 ? this.required(effectId) : null;
  }

  private required(effectId: string): GuidedEffectJournalRecord {
    const record = this.find(effectId);
    if (!record) throw new Error(`Guided effect journal lost ${effectId}`);
    return record;
  }
}

function sameIdentity(
  record: GuidedEffectJournalRecord,
  identity: GuidedEffectIdentity,
): boolean {
  return IDENTITY_CORE_FIELDS.every((field) => record[field] === identity[field]);
}

function receiptMatches(
  record: GuidedEffectJournalRecord,
  receipt: GuidedEffectReceipt,
): boolean {
  return RECEIPT_FIELDS.every((field) => record[field] === receipt[field]);
}

function conflict(effectId: string): PrepareGuidedEffectResult {
  return {
    ok: false,
    message: `Guided effect identity conflicts with stored request: ${effectId}`,
  };
}

function json(value: unknown, label: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`${label} must be JSON-serializable`);
  return encoded;
}

const IDENTITY_CORE_FIELDS = [
  "effectId",
  "receiptId",
  "idempotencyKey",
  "identitySha256",
  "requestSha256",
  "inputSha256",
  "targetSha256",
  "workId",
  "planRevisionId",
  "actionKey",
  "capability",
] as const;

const RECEIPT_FIELDS = [
  ...IDENTITY_CORE_FIELDS,
  "sanitizedTarget",
] as const;
