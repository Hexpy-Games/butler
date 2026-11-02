/** Largest whole-icon prefix that fits, reserving the measured label of the exact remainder. */
export function fitFavicons(total: number, room: number, icon: number, gap: number, overflowWidths: readonly number[]): number {
  if (total === 0) return 0;
  if (total * icon + (total - 1) * gap <= room) return total;
  for (let shown = total - 1; shown >= 0; shown--) {
    const width = shown * (icon + gap) + (overflowWidths[total - shown] ?? Infinity);
    if (width <= room) return shown;
  }
  return 0;
}
