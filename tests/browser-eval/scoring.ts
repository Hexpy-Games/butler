import type { FixtureTruth, L1Metrics, PerceptionSnapshot } from "./contracts.ts";

export function scoreSnapshot(truth: FixtureTruth, arm: string, snapshot: PerceptionSnapshot): L1Metrics {
  const actionable = new Set(snapshot.nodes.filter((n) => n.actionable && !n.coveredBy).map((n) => n.targetId));
  const realFound = truth.targets.filter((id) => snapshot.nodes.some((node) => node.targetId === id && (node.actionable || node.coveredBy !== undefined))).length;
  const decoysLeaked = truth.decoys.filter((id) => actionable.has(id)).length;
  const covered = Object.entries(truth.covered);
  const coveredCorrect = covered.filter(([id, by]) => snapshot.nodes.some((n) => n.targetId === id && n.coveredBy === by)).length;
  const snapshotBytes = Buffer.byteLength(snapshot.text);
  return { id: truth.id, arm, realFound, realTotal: truth.targets.length, decoysLeaked, decoysTotal: truth.decoys.length,
    coveredCorrect, coveredTotal: covered.length, realTargetRecall: realFound / truth.targets.length,
    decoyLeakRate: truth.decoys.length ? decoysLeaked / truth.decoys.length : 0,
    coveredAnnotationAccuracy: covered.length ? coveredCorrect / covered.length : null,
    snapshotBytes, snapshotTokensEstimate: Math.ceil(snapshotBytes / 4), scriptMs: snapshot.scriptMs, gridSampleMs: snapshot.gridSampleMs ?? null };
}
