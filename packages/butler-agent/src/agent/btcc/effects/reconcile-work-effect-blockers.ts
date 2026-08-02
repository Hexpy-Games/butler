import type {
  ExecuteGuidedEffectInput,
  GuidedEffectFaultHook,
  GuidedEffectIdentity,
  GuidedEffectJournal,
  GuidedEffectJournalRecord,
  GuidedEffectOutcome,
  GuidedWorkEffectBlockerRecord,
} from "./contracts.ts";
import { stableEffectJson } from "./effect-identity.ts";
import {
  effectError,
  errorMessage,
  reconciliationError,
  uncertain,
} from "./effect-outcomes.ts";
import { recordAppliedEffect } from "./effect-receipt.ts";

export async function reconcileWorkEffectBlockers<TNormalizedInput, TResult>(
  context: {
    input: ExecuteGuidedEffectInput<TNormalizedInput, TResult>;
    identity: GuidedEffectIdentity;
    current: GuidedEffectJournalRecord;
    journal: GuidedEffectJournal;
    now: () => string;
    faultHook: GuidedEffectFaultHook;
    normalizedTarget: string;
    normalizedInput: TNormalizedInput;
  },
): Promise<GuidedEffectOutcome<TResult> | null> {
  const blockers = await context.journal.listEffectBlockersForReconciliation(
    context.identity.workId,
  );
  const matching: ClassifiedBlocker[] = [];
  for (const blocker of blockers) {
    const relation = await classifyBlocker(context, blocker);
    if (relation !== "unrelated") matching.push({ blocker, relation });
  }
  if (matching.length === 0) return null;

  const occurrences = groupOccurrences(matching);
  const resolvedNotApplied: string[] = [];
  let canAdoptPriorResult = false;
  let mustDispatchCurrentEffect = false;
  let adoptedResult: TResult | undefined;
  for (const { blocker, relation } of occurrences) {
    let priorInput: TNormalizedInput;
    try {
      priorInput = context.input.adapter.normalizeInput(blocker.input);
    } catch (error) {
      if (blocker.status === "applied" && relation === "overlapping") {
        mustDispatchCurrentEffect = true;
        continue;
      }
      return uncertain(priorReconciliationError(error));
    }
    let priorTarget: string;
    try {
      priorTarget = context.input.adapter.normalizeTarget(blocker.target);
    } catch (error) {
      if (!context.input.adapter.classifyEffectBlocker) {
        return uncertain(priorReconciliationError(error));
      }
      priorTarget = context.normalizedTarget;
    }
    let reconciliation;
    try {
      reconciliation = await context.input.adapter.reconcile({
        normalizedTarget: priorTarget,
        normalizedInput: priorInput,
        idempotencyKey: blocker.idempotencyKey,
        signal: context.input.signal,
        dispatchAttempts: 1,
      });
    } catch (error) {
      if (blocker.status === "applied" && relation === "overlapping") {
        mustDispatchCurrentEffect = true;
        continue;
      }
      return uncertain(priorReconciliationError(error));
    }
    if (reconciliation.status === "uncertain") {
      if (blocker.status === "applied" && relation === "overlapping") {
        mustDispatchCurrentEffect = true;
        continue;
      }
      return uncertain(reconciliationError(reconciliation.error));
    }
    if (reconciliation.status === "not_applied") {
      if (blocker.status === "applied") {
        if (relation === "overlapping") {
          mustDispatchCurrentEffect = true;
          continue;
        }
        return uncertain(appliedEvidenceConflict());
      }
      resolvedNotApplied.push(blocker.sourceOccurrenceId);
      continue;
    }
    if (blocker.status === "unresolved") {
      await context.journal.resolveBlockerOccurrence(
        context.identity.workId,
        blocker.sourceOccurrenceId,
        "applied",
      );
      await context.faultHook("after_blocker_resolution", context.identity);
    }
    if (relation === "ambiguous") {
      return uncertain(effectError(
        "effect_reconciliation_required",
        "A prior effect was applied, but its legacy target cannot be mapped uniquely to the current target.",
      ));
    }
    if (relation === "equivalent") {
      if (!canAdoptPriorResult) adoptedResult = reconciliation.result;
      canAdoptPriorResult = true;
    } else {
      mustDispatchCurrentEffect = true;
    }
  }

  for (const sourceOccurrenceId of resolvedNotApplied) {
    await context.journal.resolveBlockerOccurrence(
      context.identity.workId,
      sourceOccurrenceId,
      "not_applied",
    );
  }
  if (!canAdoptPriorResult || mustDispatchCurrentEffect) {
    return null;
  }

  if (context.current.status === "applied") {
    return null;
  }
  const adopted = await recordAppliedEffect({
    journal: context.journal,
    identity: context.identity,
    current: context.current,
    result: adoptedResult as TResult,
    now: context.now,
    faultHook: context.faultHook,
  });
  if (!adopted.ok) return adopted;
  return adopted;
}

type ClassifiedBlocker = {
  blocker: GuidedWorkEffectBlockerRecord;
  relation: "overlapping" | "equivalent" | "ambiguous";
};

async function classifyBlocker<TNormalizedInput, TResult>(
  context: {
    input: ExecuteGuidedEffectInput<TNormalizedInput, TResult>;
    normalizedTarget: string;
    normalizedInput: TNormalizedInput;
  },
  blocker: GuidedWorkEffectBlockerRecord,
): Promise<"unrelated" | "overlapping" | "equivalent" | "ambiguous"> {
  if (context.input.adapter.classifyEffectBlocker) {
    try {
      return await context.input.adapter.classifyEffectBlocker({
        blockerCapability: blocker.capability,
        blockerTarget: blocker.target,
        blockerInput: blocker.input,
        normalizedTarget: context.normalizedTarget,
        normalizedInput: context.normalizedInput,
      });
    } catch {
      return "ambiguous";
    }
  }
  if (blocker.capability !== context.input.adapter.capability) {
    return "unrelated";
  }
  try {
    if (
      context.input.adapter.normalizeTarget(blocker.target) !==
        context.normalizedTarget
    ) return "unrelated";
    return sameInput(
        context.input.adapter.normalizeInput(blocker.input),
        context.normalizedInput,
      )
      ? "equivalent"
      : "overlapping";
  } catch {
    try {
      return sameInput(
          context.input.adapter.normalizeInput(blocker.input),
          context.normalizedInput,
        )
        ? "equivalent"
        : "unrelated";
    } catch {
      return "unrelated";
    }
  }
}

function groupOccurrences(
  blockers: ClassifiedBlocker[],
): ClassifiedBlocker[] {
  const grouped = new Map<string, ClassifiedBlocker>();
  for (const item of blockers) {
    const key = item.blocker.sourceOccurrenceId;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, item);
      continue;
    }
    current.relation = moreConservativeRelation(
      current.relation,
      item.relation,
    );
  }
  return [...grouped.values()];
}

function moreConservativeRelation(
  left: ClassifiedBlocker["relation"],
  right: ClassifiedBlocker["relation"],
): ClassifiedBlocker["relation"] {
  const rank = { equivalent: 0, overlapping: 1, ambiguous: 2 } as const;
  return rank[left] >= rank[right] ? left : right;
}

function sameInput(left: unknown, right: unknown): boolean {
  return stableEffectJson(left) === stableEffectJson(right);
}

function priorReconciliationError(error: unknown) {
  return effectError(
    "effect_reconciliation_required",
    errorMessage(
      error,
      "A prior effect on this exact target must be reconciled before dispatch.",
    ),
  );
}

function appliedEvidenceConflict() {
  return effectError(
    "effect_reconciliation_required",
    "Durable legacy evidence says the prior effect was applied, but its original occurrence can no longer confirm that result.",
  );
}
