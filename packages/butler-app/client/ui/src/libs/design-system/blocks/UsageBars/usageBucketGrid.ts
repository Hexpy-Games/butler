/**
 * The local-time bucket grid behind bucketUsageSlots: aligned starts built
 * from wall-clock fields, so DST and rolling windows never drift the grid.
 */

const MS_PER_DAY = 86_400_000;
export const DEFAULT_WEEK_START = 1;

/** Local calendar day number (days since 1970-01-01, counted in local dates, so DST never shifts it). */
function localDayNumber(date: Date): number {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY);
}

export const modulo = (value: number, divisor: number) => ((value % divisor) + divisor) % divisor;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
}

/**
 * Wall-clock fields of the bucket that contains `ms`. Sub-day steps align to
 * multiples of the step from local midnight; 7-day steps to `weekStartsOn`;
 * other multi-day steps to a fixed local-day grid (day number modulo the
 * step), so a rolling window keeps the same boundaries from day to day.
 */
function alignedWallClock(ms: number, stepHours: number, weekStartsOn: number): WallClock {
  const date = new Date(ms);
  const wall = { year: date.getFullYear(), month: date.getMonth(), day: date.getDate(), hour: 0 };
  const days = stepHours / 24;
  if (stepHours < 24) wall.hour = Math.floor(date.getHours() / stepHours) * stepHours;
  else if (days === 7) wall.day -= modulo(date.getDay() - weekStartsOn, 7);
  else wall.day -= modulo(localDayNumber(date), days);
  return wall;
}

/**
 * The k-th bucket start after `wall`, built from wall-clock fields (never by
 * adding to the previous start), so a DST change moves at most the one
 * bucket it falls in. A start inside a skipped hour resolves forward.
 */
function bucketStartAt(wall: WallClock, stepHours: number, k: number): number {
  if (stepHours < 24) return new Date(wall.year, wall.month, wall.day, wall.hour + k * stepHours).getTime();
  return new Date(wall.year, wall.month, wall.day + k * (stepHours / 24)).getTime();
}

/** Start of the local-time bucket of `stepHours` that contains `ms`. */
export function alignUsageBucketStart(ms: number, stepHours: number, weekStartsOn = DEFAULT_WEEK_START): number {
  return bucketStartAt(alignedWallClock(ms, stepHours, weekStartsOn), stepHours, 0);
}

export interface BucketGrid {
  starts: number[];
  /** Start of the bucket after the last one (the last bucket's end). */
  end: number;
}

/** Bucket starts covering [fromMs, toMs); stops early once more than `limit` are needed. */
export function bucketGrid(fromMs: number, toMs: number, stepHours: number, weekStartsOn: number, limit: number): BucketGrid {
  const wall = alignedWallClock(fromMs, stepHours, weekStartsOn);
  const starts: number[] = [];
  let previous = -Infinity;
  for (let k = 0; starts.length <= limit; k += 1) {
    const start = bucketStartAt(wall, stepHours, k);
    // Two hours that resolve to one instant (a skipped hour) make one bucket.
    if (start <= previous) continue;
    if (start >= toMs) return { starts, end: start };
    starts.push(start);
    previous = start;
  }
  return { starts, end: Infinity };
}
