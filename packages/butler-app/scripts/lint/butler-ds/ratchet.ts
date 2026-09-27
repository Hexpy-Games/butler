/** Per-file violation counts keyed by path relative to the UI source root. */
export type FileCounts = Record<string, number>;

export type RatchetResult = {
  grown: Array<{ file: string; baseline: number; current: number }>;
  added: Array<{ file: string; current: number }>;
  shrunk: Array<{ file: string; baseline: number; current: number }>;
};

export const BASELINE_COMMAND = "bun run lint:ds:baseline";

export function compareRatchet(baseline: FileCounts, current: FileCounts): RatchetResult {
  const result: RatchetResult = { grown: [], added: [], shrunk: [] };
  const files = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
  for (const file of files) {
    const before = baseline[file] ?? 0;
    const after = current[file] ?? 0;
    if (before === 0 && after > 0) result.added.push({ file, current: after });
    else if (after > before) result.grown.push({ file, baseline: before, current: after });
    else if (after < before) result.shrunk.push({ file, baseline: before, current: after });
  }
  return result;
}

export function ratchetFailures(rule: string, result: RatchetResult): string[] {
  return [
    ...result.grown.map(({ file, baseline, current }) =>
      `${rule}: ${file} grew ${baseline} -> ${current}; fix the new violations (the baseline only shrinks)`),
    ...result.added.map(({ file, current }) =>
      `${rule}: ${file} has ${current} new violation(s); fix them (new files may not enter the baseline)`),
    ...result.shrunk.map(({ file, baseline, current }) =>
      `${rule}: ${file} shrank ${baseline} -> ${current}; run \`${BASELINE_COMMAND}\` to lock in the improvement`),
  ];
}

/**
 * Next baseline for regeneration: shrunk counts are taken, cleared files drop
 * out, and growth is refused unless the owner explicitly allows it.
 */
export function shrinkBaseline(
  baseline: FileCounts,
  current: FileCounts,
  options: { allowGrowth?: boolean } = {},
): { next: FileCounts; refused: string[] } {
  const next: FileCounts = {};
  const refused: string[] = [];
  const files = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
  for (const file of files) {
    const before = baseline[file] ?? 0;
    const after = current[file] ?? 0;
    if (after > before && !options.allowGrowth) {
      refused.push(`${file}: ${before} -> ${after}`);
      if (before > 0) next[file] = before;
      continue;
    }
    if (after > 0) next[file] = after;
  }
  return { next, refused };
}
