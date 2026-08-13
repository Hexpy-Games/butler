import type {
  EffectAdapterError,
  ExecuteGuidedEffectInput,
  GuidedEffectError,
  GuidedEffectOutcome,
} from "./contracts.ts";

export function dispatchPermission(
  input: Pick<ExecuteGuidedEffectInput, "accessMode" | "signal">,
): GuidedEffectError | null {
  if (input.signal.aborted) {
    return effectError(
      "effect_cancelled",
      "Effect dispatch was cancelled before the external call.",
    );
  }
  if (input.accessMode !== "full_access") {
    return effectError(
      "effect_access_denied",
      "Effect dispatch requires full_access.",
    );
  }
  return null;
}

export function dispatchError(error: EffectAdapterError): GuidedEffectError {
  return {
    code: "effect_dispatch_failed",
    message: `${error.code}: ${error.message}`,
    recoverable: error.recoverable ?? true,
  };
}

export function reconciliationError(
  error?: EffectAdapterError,
): GuidedEffectError {
  const diagnostic = effectError(
    "effect_reconciliation_required",
    error
      ? `${error.code}: ${error.message}`
      : "The target cannot yet prove whether this effect was applied.",
  );
  return error ? { ...diagnostic, sourceCode: error.code } : diagnostic;
}

export function journalConflict<TResult>(): GuidedEffectOutcome<TResult> {
  return uncertain(effectError(
    "effect_journal_conflict",
    "The effect journal changed concurrently; reconcile before another dispatch.",
  ));
}

export function cancelled<TResult>(): GuidedEffectOutcome<TResult> {
  return rejected(effectError(
    "effect_cancelled",
    "Effect execution was cancelled before reconciliation or dispatch.",
  ));
}

export function effectError(
  code: GuidedEffectError["code"],
  message: string,
): GuidedEffectError {
  return { code, message, recoverable: true };
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function rejected<TResult>(
  error: GuidedEffectError,
): GuidedEffectOutcome<TResult> {
  return { ok: false, status: "rejected", error };
}

export function failed<TResult>(
  error: GuidedEffectError,
): GuidedEffectOutcome<TResult> {
  return { ok: false, status: "failed", error };
}

export function uncertain<TResult>(
  error: GuidedEffectError,
): GuidedEffectOutcome<TResult> {
  return { ok: false, status: "uncertain", error };
}
