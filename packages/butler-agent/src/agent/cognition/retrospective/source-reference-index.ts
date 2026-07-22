import type { BtccRetrospective, BtccTrajectory } from "./contracts.ts";

export function validateRetrospectiveSourceRefs(
  retrospective: BtccRetrospective,
  trajectory: BtccTrajectory,
): void {
  const allowed = trajectorySourceRefs(trajectory);
  const sets = [
    ...Object.values(retrospective.dimensions).map((finding) => finding.sourceRefs),
    ...retrospective.candidates.flatMap((candidate) => [
      candidate.sourceRefs,
      candidate.scopeSourceRefs,
    ]),
    ...retrospective.outsideLearningSurface.map((finding) => finding.sourceRefs),
  ];
  for (const refs of sets) {
    if (refs.some((ref) => !allowed.has(ref))) {
      throw new Error("Retrospective cites a source ref outside the exact trajectory");
    }
  }
}

export function trajectorySourceRefs(trajectory: BtccTrajectory): Set<string> {
  const refs = new Set<string>([trajectory.sourceId, trajectory.turnId]);
  for (const feedback of trajectory.recentFeedback) refs.add(feedback.ref);
  collectContentRefs(trajectory.goalContract, refs);
  collectContentRefs(trajectory.phaseProducts, refs);
  collectContentRefs(trajectory.finalDossier, refs);
  collectContentRefs(trajectory.finalPayload, refs);
  return refs;
}

function collectContentRefs(value: unknown, refs: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectContentRefs(item, refs);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && typeof record.sha256 === "string") {
    refs.add(record.id);
  }
  const ref = record.ref;
  if (typeof ref === "string") refs.add(ref);
  else collectContentRefs(ref, refs);
  for (const [key, child] of Object.entries(record)) {
    if (key !== "ref") collectContentRefs(child, refs);
  }
}
