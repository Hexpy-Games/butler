// ACT-R activation decay.
// activation = ln(Σ_j t_j^(-d)) where t_j is the age of reference j in days.
// Sub-hour references clamp to t = 1/24 days to avoid numeric blowup.
// Zero references → null (callers persist as NULL, compare as -Infinity).

export const SUB_HOUR_CLAMP_DAYS = 1 / 24;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeActivation(
  referenceTsMs: number[],
  nowMs: number,
  d: number,
): number | null {
  if (referenceTsMs.length === 0) return null;
  let sum = 0;
  for (const ts of referenceTsMs) {
    let ageDays = (nowMs - ts) / MS_PER_DAY;
    if (!Number.isFinite(ageDays) || ageDays < SUB_HOUR_CLAMP_DAYS) {
      ageDays = SUB_HOUR_CLAMP_DAYS;
    }
    sum += Math.pow(ageDays, -d);
  }
  if (sum <= 0) return null;
  return Math.log(sum);
}
