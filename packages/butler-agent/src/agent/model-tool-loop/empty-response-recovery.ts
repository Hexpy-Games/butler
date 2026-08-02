const EMPTY_RESPONSE_RECOVERY_OBSERVATION =
  "The previous response contained no text or tool call. Continue with a useful answer or tool call.";

export function emptyResponseRecoveryObservation(input: {
  recoveryUsed: boolean;
  hasNextModelRound: boolean;
}): string | null {
  return !input.recoveryUsed && input.hasNextModelRound
    ? EMPTY_RESPONSE_RECOVERY_OBSERVATION
    : null;
}
