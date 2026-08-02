import type {
  ExecuteGuidedEffectInput,
  GuidedEffectFaultHook,
  GuidedEffectIdentity,
  GuidedEffectJournal,
  GuidedEffectJournalRecord,
  GuidedEffectOutcome,
  GuidedEffectService,
} from "./contracts.ts";
import { createGuidedEffectIdentity } from "./effect-identity.ts";
import {
  cancelled,
  dispatchError,
  dispatchPermission,
  effectError,
  errorMessage,
  failed,
  journalConflict,
  reconciliationError,
  rejected,
  uncertain,
} from "./effect-outcomes.ts";
import {
  recordAppliedEffect,
  replayAppliedEffect,
} from "./effect-receipt.ts";
import { resolveReviewedEffect } from "./resolve-reviewed-effect.ts";
import { reconcileWorkEffectBlockers } from
  "./reconcile-work-effect-blockers.ts";

type GuidedEffectServiceOptions = {
  now?: () => string;
  faultHook?: GuidedEffectFaultHook;
};

export function createGuidedEffectService(
  journal: GuidedEffectJournal,
  options: GuidedEffectServiceOptions = {},
): GuidedEffectService {
  const now = options.now ?? (() => new Date().toISOString());
  const faultHook = options.faultHook ?? (() => {});

  return {
    async execute<TNormalizedInput, TResult>(
      input: ExecuteGuidedEffectInput<TNormalizedInput, TResult>,
    ): Promise<GuidedEffectOutcome<TResult>> {
      const denied = dispatchPermission(input);
      if (denied) return rejected(denied);
      const resolved = resolveReviewedEffect(input);
      if (!resolved.ok) return rejected(resolved.error);

      let identity: GuidedEffectIdentity;
      try {
        identity = createGuidedEffectIdentity(resolved.value);
      } catch (error) {
        return rejected(effectError(
          "effect_request_invalid",
          errorMessage(error, "The effect input is invalid."),
        ));
      }

      await faultHook("before_intent", identity);
      const prepared = await journal.prepare(identity);
      if (!prepared.ok) {
        return rejected(effectError(
          "effect_identity_conflict",
          prepared.message,
        ));
      }
      if (prepared.created) await faultHook("after_intent", identity);
      if (prepared.record.status === "applied") {
        return replayAppliedEffect<TResult>(prepared.record);
      }

      const context = {
        input,
        identity,
        initial: prepared.record,
        journal,
        now,
        faultHook,
        normalizedTarget: resolved.value.normalizedTarget,
        normalizedInput: resolved.value.normalizedInput,
      };
      if (prepared.record.status !== "failed") {
        const blockerOutcome = await reconcileWorkEffectBlockers({
          ...context,
          current: prepared.record,
        });
        if (blockerOutcome) return blockerOutcome;
      }
      return continueEffect(context);
    },
  };
}

type ContinueEffectInput<TNormalizedInput, TResult> = {
  input: ExecuteGuidedEffectInput<TNormalizedInput, TResult>;
  identity: GuidedEffectIdentity;
  initial: GuidedEffectJournalRecord;
  journal: GuidedEffectJournal;
  now: () => string;
  faultHook: GuidedEffectFaultHook;
  normalizedTarget: string;
  normalizedInput: TNormalizedInput;
};

async function continueEffect<TNormalizedInput, TResult>(
  context: ContinueEffectInput<TNormalizedInput, TResult>,
): Promise<GuidedEffectOutcome<TResult>> {
  const { initial } = context;
  if (initial.status === "applied") return replayAppliedEffect<TResult>(initial);
  if (initial.status === "failed") {
    return failed(initial.error ?? effectError(
      "effect_journal_conflict",
      "Stored effect failure is incomplete.",
    ));
  }
  if (context.input.signal.aborted) return cancelled();

  if (initial.status === "dispatching" || initial.status === "uncertain") {
    return reconcileEffect(context, initial);
  }
  if (initial.status === "prepared" && initial.dispatchAttempts === 0) {
    // Observe the real target before the first dispatch. This safely adopts an
    // already-applied end state and reconciles journals created by older
    // runtimes without blindly repeating a mutation.
    return reconcileEffect(context, initial);
  }
  return dispatchEffect(context, initial);
}

async function reconcileEffect<TNormalizedInput, TResult>(
  context: ContinueEffectInput<TNormalizedInput, TResult>,
  current: GuidedEffectJournalRecord,
): Promise<GuidedEffectOutcome<TResult>> {
  let reconciliation;
  try {
    reconciliation = await context.input.adapter.reconcile({
      normalizedTarget: context.normalizedTarget,
      normalizedInput: context.normalizedInput,
      idempotencyKey: context.identity.idempotencyKey,
      signal: context.input.signal,
      dispatchAttempts: current.dispatchAttempts,
    });
  } catch (error) {
    const diagnostic = effectError(
      "effect_reconciliation_required",
      errorMessage(error, "The effect could not be reconciled safely."),
    );
    await context.journal.recordUncertain(
      current.effectId,
      current.journalRevision,
      diagnostic,
    );
    return uncertain(diagnostic);
  }
  if (reconciliation.status === "applied") {
    return recordAppliedEffect({
      journal: context.journal,
      identity: context.identity,
      current,
      result: reconciliation.result,
      now: context.now,
      faultHook: context.faultHook,
    });
  }
  if (reconciliation.status === "uncertain") {
    const diagnostic = reconciliationError(reconciliation.error);
    const recorded = await context.journal.recordUncertain(
      current.effectId,
      current.journalRevision,
      diagnostic,
    );
    return recorded ? uncertain(diagnostic) : journalConflict();
  }
  return dispatchEffect(context, current);
}

async function dispatchEffect<TNormalizedInput, TResult>(
  context: ContinueEffectInput<TNormalizedInput, TResult>,
  current: GuidedEffectJournalRecord,
): Promise<GuidedEffectOutcome<TResult>> {
  const denied = dispatchPermission(context.input);
  if (denied) return rejected(denied);

  const claimed = await context.journal.claimDispatch(
    current.effectId,
    current.journalRevision,
  );
  if (!claimed) return journalConflict();
  await context.faultHook("after_dispatch_marker", context.identity);

  const finalDenial = dispatchPermission(context.input);
  if (finalDenial) {
    const restored = await context.journal.returnToPrepared(
      claimed.effectId,
      claimed.journalRevision,
    );
    return restored ? rejected(finalDenial) : journalConflict();
  }

  let dispatched;
  try {
    dispatched = await context.input.adapter.dispatch({
      normalizedTarget: context.normalizedTarget,
      normalizedInput: context.normalizedInput,
      idempotencyKey: context.identity.idempotencyKey,
      signal: context.input.signal,
    });
  } catch (error) {
    const diagnostic = effectError(
      "effect_reconciliation_required",
      errorMessage(error, "Effect dispatch ended without a reliable outcome."),
    );
    const recorded = await context.journal.recordUncertain(
      claimed.effectId,
      claimed.journalRevision,
      diagnostic,
    );
    return recorded ? uncertain(diagnostic) : journalConflict();
  }

  if (dispatched.status === "not_applied") {
    const diagnostic = dispatchError(dispatched.error);
    const recorded = await context.journal.recordFailed(
      claimed.effectId,
      claimed.journalRevision,
      diagnostic,
    );
    return recorded ? failed(diagnostic) : journalConflict();
  }
  if (dispatched.status === "uncertain") {
    const diagnostic = reconciliationError(dispatched.error);
    const recorded = await context.journal.recordUncertain(
      claimed.effectId,
      claimed.journalRevision,
      diagnostic,
    );
    return recorded ? uncertain(diagnostic) : journalConflict();
  }

  await context.faultHook("after_dispatch", context.identity);
  return recordAppliedEffect({
    journal: context.journal,
    identity: context.identity,
    current: claimed,
    result: dispatched.result,
    now: context.now,
    faultHook: context.faultHook,
  });
}
