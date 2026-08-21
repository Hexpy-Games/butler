/** A factual contradiction is terminal; an unavailable read is retryable. */
export class StewardCompletionEvidenceError extends Error {
  readonly kind: "factual" | "retryable";

  constructor(code: string, kind: "factual" | "retryable") {
    super(code);
    this.name = "StewardCompletionEvidenceError";
    this.kind = kind;
  }
}

export function factualCompletionFailure(code: string): never {
  throw new StewardCompletionEvidenceError(code, "factual");
}

export function retryableCompletionFailure(code: string): never {
  throw new StewardCompletionEvidenceError(code, "retryable");
}

export function isFactualCompletionFailure(error: unknown): boolean {
  return (
    error instanceof StewardCompletionEvidenceError && error.kind === "factual"
  );
}
