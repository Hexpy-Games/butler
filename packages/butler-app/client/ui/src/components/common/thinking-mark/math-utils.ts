export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function smootherstep(value: number) {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function interpolatePoints(u: number, points: Array<[number, number]>) {
  for (let i = 0; i < points.length - 1; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    if (!current || !next) continue;
    if (u >= current[0] && u <= next[0]) {
      const span = next[0] - current[0];
      const local = span === 0 ? 0 : (u - current[0]) / span;
      return current[1] + (next[1] - current[1]) * local;
    }
  }

  return points[points.length - 1]?.[1] ?? 0;
}

export function bowtieDistance(u: number) {
  return interpolatePoints(u, [
    [0, 136],
    [0.5, 0],
    [1, 136],
  ]);
}