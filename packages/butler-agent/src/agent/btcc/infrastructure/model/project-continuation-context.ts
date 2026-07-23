import type { PhaseEnvelope } from "../../core/index.ts";

const CONCEPTION_PHASES = new Set([
  "conception_opening",
  "conception_deliberation",
  "contract_review",
]);

export function projectContinuationContext(envelope: PhaseEnvelope) {
  if (!CONCEPTION_PHASES.has(envelope.phase)) {
    return { candidates: [] };
  }
  return {
    rule: [
      "Compare the current request with the projected goal, blocker, and frontier.",
      "Select a candidate only when the user is semantically resuming that deferred goal.",
      "Opaque refs are identities, not search terms; do not probe unrelated stores to resolve them.",
      "If the projection is unrelated or insufficient, continue as a new request.",
    ].join(" "),
    candidates: envelope.context.continuationCandidates ?? [],
  };
}
