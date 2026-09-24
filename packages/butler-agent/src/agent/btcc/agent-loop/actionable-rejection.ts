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
