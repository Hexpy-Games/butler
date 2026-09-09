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
  uncertain,
  uncertainEvidenceFromRecord,
} from "./effect-outcomes.ts";
import { resolveJournalConflict } from "./effect-journal-conflict.ts";

export { replayAppliedEffect } from "./effect-journal-conflict.ts";

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
    const recorded = await input.journal.recordUncertain(
      input.current.effectId,
      input.current.journalRevision,
      diagnostic,
    );
    return recorded
      ? uncertain(diagnostic, uncertainEvidenceFromRecord(recorded))
      : await resolveJournalConflict<TResult>({
        journal: input.journal,
        identity: input.identity,
      });
  }
  const receipt: GuidedEffectReceipt<TResult> = {
    ...input.identity,
    sanitizedTarget: input.current.sanitizedTarget,
    result: input.result,
    appliedAt: input.now(),
    dispatchAttempt: input.current.dispatchAttempts,
  };
  const recorded = await input.journal.recordApplied(
    input.current.effectId,
    input.current.journalRevision,
    input.result,
    receipt,
  );
  if (!recorded) {
    return await resolveJournalConflict<TResult>({
      journal: input.journal,
      identity: input.identity,
    });
  }
  await input.faultHook("after_receipt", input.identity);
  return {
    ok: true,
    status: "applied",
    replayed: false,
    result: input.result,
    receipt,
  };
}
