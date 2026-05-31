// Edge-weight boost driven by cross-session mention count over the last 7 days.
// boost = ln(1 + n). Consolidator adds this to the existing edge weight.

export function computeEdgeWeightBoost(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.log(1 + count);
}
