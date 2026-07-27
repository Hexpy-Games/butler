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
      "Select a candidate only when the user is semantically resuming that deferred or user-stopped goal.",
      "At Opening, propose an exact selected open-Program candidate with managed_program_continuation. Propose a stopped closed-Work candidate with managed_finalization_continuation. Both are durable_work; never substitute Assisted merely because the next action is read, Review, Consolidation, Reporting, or Delivery.",
      "Use Assisted only for a candidate-free bounded new request; unrelated candidates do not force Managed work.",
      "The projected goal, blocker, readiness, and frontier must describe the same work.",
      "Opaque refs are identities, not search terms; do not probe unrelated stores to resolve them.",
      "If the projection is unrelated or insufficient, continue as a new request.",
      "Goal Review must explicitly bind or reject the exact candidate proposed by Opening and cannot substitute or silently omit it.",
      "Emit cancel_work only when the current request explicitly and semantically abandons the exact candidate; never infer abandonment from its prior Stop state.",
    ].join(" "),
    candidates: envelope.context.continuationCandidates ?? [],
  };
}
