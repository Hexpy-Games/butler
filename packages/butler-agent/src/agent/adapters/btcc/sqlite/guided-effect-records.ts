import type {
  GuidedEffectError,
  GuidedEffectJournalRecord,
  GuidedEffectJournalStatus,
  GuidedEffectReceipt,
} from "../../../btcc/effects/index.ts";

export type GuidedEffectRow = {
  effect_id: string;
  receipt_id: string;
  idempotency_key: string;
  identity_sha256: string;
  request_sha256: string;
  input_sha256: string;
  target_sha256: string;
  work_id: string;
  plan_revision_id: string;
  action_key: string;
  capability: string;
  sanitized_target: string;
  status: GuidedEffectJournalStatus;
  journal_revision: number;
  dispatch_attempts: number;
  result_json: string | null;
  receipt_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
};

export function hydrateGuidedEffect(
  row: GuidedEffectRow,
): GuidedEffectJournalRecord {
  return {
    effectId: row.effect_id,
    receiptId: row.receipt_id,
    idempotencyKey: row.idempotency_key,
    identitySha256: row.identity_sha256,
    requestSha256: row.request_sha256,
    inputSha256: row.input_sha256,
    targetSha256: row.target_sha256,
    workId: row.work_id,
    planRevisionId: row.plan_revision_id,
    actionKey: row.action_key,
    capability: row.capability,
    sanitizedTarget: row.sanitized_target,
    status: row.status,
    journalRevision: row.journal_revision,
    dispatchAttempts: row.dispatch_attempts,
    ...(row.result_json !== null
      ? { result: JSON.parse(row.result_json) as unknown }
      : {}),
    ...(row.receipt_json !== null
      ? { receipt: JSON.parse(row.receipt_json) as GuidedEffectReceipt }
      : {}),
    ...(row.error_json !== null
      ? { error: JSON.parse(row.error_json) as GuidedEffectError }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
