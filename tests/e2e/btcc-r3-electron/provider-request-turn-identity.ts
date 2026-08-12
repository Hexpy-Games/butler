import type { ProviderRequestTurnIdentity } from "./contracts.ts";
import type { ProviderRequestObservation } from
  "./provider-observation-proxy.ts";

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
  return input.requests
    .filter((request) => !input.ordinalsBeforeSubmission.has(request.ordinal))
    .map((request) => ({
      ordinal: request.ordinal,
      sessionId: input.sessionId,
      turnId: input.turnId,
      requestKind: request.requestKind,
      attemptDigest: request.attemptDigest,
    }));
}
