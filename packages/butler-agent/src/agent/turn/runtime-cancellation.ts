export interface RuntimeCancellationCandidate {
  name?: unknown;
  code?: unknown;
  message?: unknown;
}

export function isRuntimeCancellationFailure(candidate: RuntimeCancellationCandidate): boolean {
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return (
    code === "turn_cancelled" ||
    ((name === "AbortError" || code === "ABORT_ERR") && isRuntimeCancellationMessage(message)) ||
    isRuntimeCancellationMessage(message)
  );
}

function isRuntimeCancellationMessage(message: string): boolean {
  return /(?:runtime|butler|turn|user).{0,40}(?:cancelled|canceled|aborted)|(?:cancelled|canceled|aborted).{0,40}(?:runtime|butler|turn|user)/iu
    .test(message);
}
