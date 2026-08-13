import type { ProviderRequestTurnIdentity } from "./contracts.ts";
import type { ProviderRequestObservation } from
  "./provider-observation-proxy.ts";

const PHYSICAL_ATTEMPT_DIGEST = /^[A-Za-z0-9_-]{43}$/u;

type ProviderRequestIdentitySource = Pick<
  ProviderRequestObservation,
  "attemptDigest" | "ordinal" | "requestKind"
>;

export function providerRequestTurnIdentities(input: {
  requests: readonly ProviderRequestIdentitySource[];
  ordinalsBeforeSubmission: ReadonlySet<number>;
  sessionId: string;
  turnId: string;
}): ProviderRequestTurnIdentity[] {
  return input.requests.flatMap((request) => {
    if (input.ordinalsBeforeSubmission.has(request.ordinal)) return [];
    if (typeof request.attemptDigest !== "string" || !PHYSICAL_ATTEMPT_DIGEST.test(request.attemptDigest)) {
      throw new Error("provider_request_physical_attempt_digest_invalid");
    }
    return [physicalIdentity(request, input.sessionId, input.turnId, request.attemptDigest)];
  });
}

function physicalIdentity(
  request: ProviderRequestIdentitySource,
  sessionId: string,
  turnId: string,
  physicalAttemptDigest: string,
): ProviderRequestTurnIdentity {
  const identity = { ordinal: request.ordinal, sessionId, turnId, physicalAttemptDigest };
  switch (request.requestKind) {
    case "agent": return { ...identity, requestKind: "agent" };
    case "auxiliary": return { ...identity, requestKind: "auxiliary" };
    case "title": return { ...identity, requestKind: "title" };
    case "tool_provider": return { ...identity, requestKind: "tool_provider" };
  }
}
