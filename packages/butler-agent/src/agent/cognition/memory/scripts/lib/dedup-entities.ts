// Pure entity-dedup primitives for the consolidate sub-phase.
// Candidate rule:
//   same type AND (Levenshtein(name_a, name_b) <= 2 OR normalize(name_a) == normalize(name_b))
// Canonical within a cluster is the max by tuple (-activation, -len(name), id).
// NULL activation sorts last.

export interface EntityRow {
  id: string;
  type: string;
  name: string;
  activation: number | null;
}

export interface MergePlan {
  canonical: EntityRow;
  losers: EntityRow[];
}

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function isCandidate(a: EntityRow, b: EntityRow): boolean {
  if (a.type !== b.type) return false;
  if (normalizeName(a.name) === normalizeName(b.name)) return true;
  return levenshtein(a.name, b.name) <= 2;
}

/** Union-find across rows. Returns clusters of size ≥ 2. */
export function findCandidateClusters(rows: EntityRow[]): EntityRow[][] {
  const parent = new Map<string, string>();
  rows.forEach((r) => parent.set(r.id, r.id));
  const find = (x: string): string => {
    let p = parent.get(x)!;
    while (p !== parent.get(p)) p = parent.get(p)!;
    parent.set(x, p);
    return p;
  };
  const union = (x: string, y: string) => {
    const px = find(x);
    const py = find(y);
    if (px !== py) parent.set(px, py);
  };

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (isCandidate(rows[i], rows[j])) union(rows[i].id, rows[j].id);
    }
  }

  const groups = new Map<string, EntityRow[]>();
  for (const r of rows) {
    const root = find(r.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(r);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Canonical selection: max by (-activation, -len(name), id-asc). Null activation sorts last. */
export function selectCanonical(cluster: EntityRow[]): {
  canonical: EntityRow;
  losers: EntityRow[];
} {
  const sorted = [...cluster].sort((a, b) => {
    const av = a.activation ?? -Infinity;
    const bv = b.activation ?? -Infinity;
    if (av !== bv) return bv - av;
    if (a.name.length !== b.name.length) return b.name.length - a.name.length;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const [canonical, ...losers] = sorted;
  return { canonical, losers };
}

export function planMerges(rows: EntityRow[]): MergePlan[] {
  return findCandidateClusters(rows).map(selectCanonical);
}
