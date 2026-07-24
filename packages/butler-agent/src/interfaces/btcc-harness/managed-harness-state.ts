export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function nestedValue(
  state: Record<string, unknown>,
  ...path: string[]
): unknown {
  let value: unknown = state;
  for (const key of path) value = asRecord(value)[key];
  return value;
}

export function executionTargetKind(state: Record<string, unknown>): unknown {
  return nestedValue(state, "executionTarget", "target", "kind");
}

export function firstContinuationCandidateId(
  state: Record<string, unknown>,
): string {
  const candidate = asRecord(asArray(state.continuationCandidates)[0]);
  const id = candidate.candidateId;
  if (typeof id !== "string") {
    throw new Error("Harness continuation candidate is missing");
  }
  return id;
}
