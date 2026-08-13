export type PhysicalRequestRole = "agent" | "auxiliary" | "title" | "tool_provider";

const PHYSICAL_ATTEMPT_DIGEST = /^[A-Za-z0-9_-]{43}$/u;

export function isPhysicalRequestRole(value: unknown): value is PhysicalRequestRole {
  return value === "agent" || value === "auxiliary" || value === "title" || value === "tool_provider";
}

export function physicalAttemptDigest(value: unknown): string | null {
  return typeof value === "string" && PHYSICAL_ATTEMPT_DIGEST.test(value) ? value : null;
}

export function physicalRequestIdentityMatches(
  request: Record<string, unknown>,
  membership: { ordinal: number; requestKind: PhysicalRequestRole; physicalAttemptDigest: string },
): boolean {
  return request.ordinal === membership.ordinal && request.requestKind === membership.requestKind &&
    request.attemptDigest === membership.physicalAttemptDigest;
}

export function physicalRequestEnvelopeMatches(
  request: Record<string, unknown>,
  envelope: { physicalAttemptDigest: string; providerSendBytes: number; observedAtMs: number },
): boolean {
  return request.attemptDigest === envelope.physicalAttemptDigest &&
    request.serializedRequestBytes === envelope.providerSendBytes &&
    typeof request.terminatedAtMs === "number" &&
    Math.abs(envelope.observedAtMs - request.terminatedAtMs) <= 5_000;
}

export function terminalStatusMatchesProviderStatus(terminal: unknown, status: unknown): boolean {
  if (terminal === "completed") return typeof status === "number" && status >= 200 && status < 300;
  if (terminal === "failed") return status === null || typeof status === "number" && (status < 200 || status >= 300);
  return terminal === "cancelled" && (status === null || typeof status === "number");
}

export function isAgentSc01Role(role: PhysicalRequestRole): role is "agent" {
  return role === "agent";
}
