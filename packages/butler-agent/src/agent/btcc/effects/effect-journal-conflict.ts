import type {
  GuidedEffectIdentity,
  GuidedEffectJournal,
  GuidedEffectJournalRecord,
  GuidedEffectOutcome,
} from "./contracts.ts";
import {
  effectError,
  failed,
  journalConflict,
  uncertain,
  uncertainEvidenceFromRecord,
} from "./effect-outcomes.ts";

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

export function sameIdentityCore(
  record: GuidedEffectJournalRecord,
  identity: GuidedEffectIdentity,
): boolean {
  return IDENTITY_CORE_FIELDS.every((field) => record[field] === identity[field]);
}

export async function resolveJournalConflict<TResult>(input: {
  journal: GuidedEffectJournal;
  identity: GuidedEffectIdentity;
}): Promise<GuidedEffectOutcome<TResult>> {
  const record = await input.journal.find(input.identity.effectId);
  if (!record || !sameIdentityCore(record, input.identity)) {
    return journalConflict<TResult>();
  }
  if (record.status === "applied") {
    return replayAppliedEffect<TResult>(record);
  }
  if (record.status === "uncertain") {
    return storedUncertainOutcome<TResult>(record);
  }
  if (record.status === "failed") {
    return failed(record.error ?? effectError(
      "effect_journal_conflict",
      "Stored effect failure is incomplete.",
    ));
  }
  if (
    Number.isInteger(record.dispatchAttempts) &&
    record.dispatchAttempts > 0
  ) {
    return uncertain(effectError(
      "effect_journal_conflict",
      "The effect journal changed concurrently; reconcile before another dispatch.",
    ), {
      effectId: record.effectId,
      identitySha256: record.identitySha256,
      dispatchAttempt: record.dispatchAttempts,
      errorCode: "effect_journal_conflict",
    });
  }
  return journalConflict<TResult>();
}

export function replayAppliedEffect<TResult>(
  record: GuidedEffectJournalRecord,
): GuidedEffectOutcome<TResult> {
  if (!record.receipt || !("result" in record)) return journalConflict();
  const storedAttempt = record.receipt.dispatchAttempt;
  const dispatchAttempt =
    typeof storedAttempt === "number" && Number.isInteger(storedAttempt) &&
      storedAttempt >= 0
      ? storedAttempt
      : record.dispatchAttempts;
  const result = record.result as TResult;
  return {
    ok: true,
    status: "applied",
    replayed: true,
    result,
    receipt: { ...record.receipt, result, dispatchAttempt },
  };
}

export function storedUncertainOutcome<TResult>(
  record: GuidedEffectJournalRecord,
): GuidedEffectOutcome<TResult> {
  return uncertain(
    record.error ?? effectError(
      "effect_journal_conflict",
      "Stored effect uncertainty is incomplete.",
    ),
    uncertainEvidenceFromRecord(record),
  );
}
