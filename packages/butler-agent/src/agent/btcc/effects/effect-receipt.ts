import type {
  GuidedEffectFaultHook,
  GuidedEffectIdentity,
  GuidedEffectJournal,
  GuidedEffectJournalRecord,
  GuidedEffectOutcome,
  GuidedEffectReceipt,
} from "./contracts.ts";
import { stableEffectJson } from "./effect-identity.ts";
import {
  effectError,
  errorMessage,
  journalConflict,
  uncertain,
} from "./effect-outcomes.ts";

export async function recordAppliedEffect<TResult>(input: {
  journal: GuidedEffectJournal;
  identity: GuidedEffectIdentity;
  current: GuidedEffectJournalRecord;
  result: TResult;
  now: () => string;
  faultHook: GuidedEffectFaultHook;
}): Promise<GuidedEffectOutcome<TResult>> {
  try {
    stableEffectJson(input.result);
  } catch (error) {
    const diagnostic = effectError(
      "effect_reconciliation_required",
      errorMessage(error, "Effect result cannot be stored safely."),
    );
    await input.journal.recordUncertain(
      input.current.effectId,
      input.current.journalRevision,
      diagnostic,
    );
    return uncertain(diagnostic);
  }
  const receipt: GuidedEffectReceipt<TResult> = {
    ...input.identity,
    sanitizedTarget: input.current.sanitizedTarget,
    result: input.result,
    appliedAt: input.now(),
  };
  const recorded = await input.journal.recordApplied(
    input.current.effectId,
    input.current.journalRevision,
    input.result,
    receipt,
  );
  if (!recorded) return journalConflict();
  await input.faultHook("after_receipt", input.identity);
  return {
    ok: true,
    status: "applied",
    replayed: false,
    result: input.result,
    receipt,
  };
}

export function replayAppliedEffect<TResult>(
  record: GuidedEffectJournalRecord,
): GuidedEffectOutcome<TResult> {
  if (!record.receipt || !("result" in record)) return journalConflict();
  return {
    ok: true,
    status: "applied",
    replayed: true,
    result: record.result as TResult,
    receipt: record.receipt as GuidedEffectReceipt<TResult>,
  };
}
