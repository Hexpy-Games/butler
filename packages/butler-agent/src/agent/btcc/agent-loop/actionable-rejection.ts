/**
 * A model-facing rejection always says why, what is allowed instead, and the
 * current state the model must reason from.
 */
export type ActionableRejection = {
  ok: false;
  error: {
    code: string;
    message: string;
    reason: string;
    alternatives: string[];
    state: Record<string, unknown>;
  };
};

export function rejection(input: {
  code: string;
  reason: string;
  alternatives: readonly string[];
  state: Record<string, unknown>;
}): ActionableRejection {
  const alternatives = [...input.alternatives];
  return {
    ok: false,
    error: {
      code: input.code,
      message: alternatives.length
        ? `${input.reason} Allowed alternatives: ${alternatives.join(", ")}.`
        : input.reason,
      reason: input.reason,
      alternatives,
      state: { ...input.state },
    },
  };
}

/** Thrown where a result cannot be returned directly; executors convert it. */
export class ActionableRejectionError extends Error {
  readonly code: string;
  readonly rejection: ActionableRejection["error"];
  constructor(input: Parameters<typeof rejection>[0]) {
    const value = rejection(input).error;
    super(value.message);
    this.name = "ActionableRejectionError";
    this.code = value.code;
    this.rejection = value;
  }
}

export function rejectionFromError(error: unknown): ActionableRejection | undefined {
  const value = error && typeof error === "object" ? Reflect.get(error, "rejection") : undefined;
  if (!value || typeof value !== "object" || typeof Reflect.get(value, "code") !== "string") return undefined;
  return { ok: false, error: value as ActionableRejection["error"] };
}
