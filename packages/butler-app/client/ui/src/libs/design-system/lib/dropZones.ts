/**
 * Drop zones for drag-and-drop lists (DS spec M5 Drag Feedback).
 *
 * Hit testing uses layout boxes (offset geometry), which drop feedback
 * (translate, scale, rings) never changes, so feedback cannot move the zones
 * under the pointer. Zone boundaries and the current row have hysteresis, and
 * entering "combine" (group / drop inside) waits for a short dwell.
 */

export type DropZone = "before" | "combine" | "after";

export interface DropZoneBox {
  /** Viewport top of the row header in layout (untransformed) position. */
  top: number;
  height: number;
}

export interface DropZoneRules {
  /** The row accepts a drop onto it (group, drop inside). */
  combine: boolean;
  /** The row has an after zone (false for an expanded folder). Default true. */
  after?: boolean;
}

export interface DropZoneCandidate<K> extends DropZoneBox, DropZoneRules {
  key: K;
}

export interface DropZoneHit<K> {
  key: K;
  zone: DropZone;
}

/** Share of the row height given to each edge (insert) zone when it can combine. */
export const DROP_ZONE_EDGE = 0.25;
/** Px the pointer must travel past a boundary before the zone flips. */
export const DROP_ZONE_HYSTERESIS = 4;
/** Ms the pointer rests in a combine zone before it becomes the drop. */
export const DROP_ZONE_COMBINE_DWELL = 150;
/** Px between rows (gaps) that still resolve to the nearest row. */
const NEAREST_ROW_SLACK = 8;

function zonesFor(rules: DropZoneRules): Array<{ zone: DropZone; end: number }> {
  const after = rules.after !== false;
  if (rules.combine && after) {
    return [
      { zone: "before", end: DROP_ZONE_EDGE },
      { zone: "combine", end: 1 - DROP_ZONE_EDGE },
      { zone: "after", end: Infinity },
    ];
  }
  if (rules.combine) return [{ zone: "before", end: DROP_ZONE_EDGE }, { zone: "combine", end: Infinity }];
  if (after) return [{ zone: "before", end: 0.5 }, { zone: "after", end: Infinity }];
  return [{ zone: "before", end: Infinity }];
}

/**
 * The zone under `y` for one row. A boundary next to the `current` zone moves
 * `hysteresis` px away from it, so jitter at a boundary keeps the zone.
 */
export function resolveDropZone(
  y: number,
  box: DropZoneBox,
  rules: DropZoneRules,
  current?: DropZone,
  hysteresis = DROP_ZONE_HYSTERESIS,
): DropZone {
  const offset = y - box.top;
  const zones = zonesFor(rules);
  for (let index = 0; index < zones.length - 1; index += 1) {
    const zone = zones[index]!;
    let boundary = zone.end * box.height;
    if (current === zone.zone) boundary += hysteresis;
    else if (current === zones[index + 1]!.zone) boundary -= hysteresis;
    if (offset < boundary) return zone.zone;
  }
  return zones[zones.length - 1]!.zone;
}

export interface DropZoneTrackerOptions<K> {
  /** Called whenever the resolved hit changes (null: nothing under the pointer). */
  onChange?: (hit: DropZoneHit<K> | null) => void;
  hysteresis?: number;
  dwell?: number;
  /** Timer used to commit a combine after the dwell; returns a cancel function. */
  schedule?: (run: () => void, delay: number) => () => void;
}

export interface DropZoneTracker<K> {
  /** Resolve the pointer (`y`, viewport px) against the rows; `now` in ms. */
  update(y: number, rows: readonly DropZoneCandidate<K>[], now: number): DropZoneHit<K> | null;
  reset(): void;
  readonly current: DropZoneHit<K> | null;
}

const defaultSchedule = (run: () => void, delay: number) => {
  const timer = setTimeout(run, delay);
  return () => clearTimeout(timer);
};

function rowAt<K>(y: number, rows: readonly DropZoneCandidate<K>[], current: DropZoneHit<K> | null, hysteresis: number) {
  const kept = current ? rows.find((row) => row.key === current.key) : undefined;
  if (kept && y >= kept.top - hysteresis && y <= kept.top + kept.height + hysteresis) return kept;
  let nearest: DropZoneCandidate<K> | undefined;
  let distance = Infinity;
  for (const row of rows) {
    const away = y < row.top ? row.top - y : y >= row.top + row.height ? y - (row.top + row.height) : 0;
    if (away < distance) {
      nearest = row;
      distance = away;
    }
  }
  return distance <= NEAREST_ROW_SLACK ? nearest : undefined;
}

export function createDropZoneTracker<K>({
  onChange,
  hysteresis = DROP_ZONE_HYSTERESIS,
  dwell = DROP_ZONE_COMBINE_DWELL,
  schedule = defaultSchedule,
}: DropZoneTrackerOptions<K> = {}): DropZoneTracker<K> {
  let current: DropZoneHit<K> | null = null;
  let pending: { key: K; since: number; cancel: () => void } | null = null;
  let last: { y: number; rows: readonly DropZoneCandidate<K>[] } | null = null;

  const clearPending = () => {
    pending?.cancel();
    pending = null;
  };
  const commit = (hit: DropZoneHit<K> | null) => {
    if (hit?.key === current?.key && hit?.zone === current?.zone) return current;
    current = hit;
    onChange?.(hit);
    return hit;
  };

  const update = (y: number, rows: readonly DropZoneCandidate<K>[], now: number): DropZoneHit<K> | null => {
    last = { y, rows };
    const row = rowAt(y, rows, current, hysteresis);
    if (!row) {
      clearPending();
      return commit(null);
    }
    const same = current?.key === row.key;
    const zone = resolveDropZone(y, row, row, same ? current!.zone : undefined, hysteresis);
    if (zone !== "combine" || (same && current!.zone === "combine") || dwell <= 0) {
      clearPending();
      return commit({ key: row.key, zone });
    }
    if (!pending || pending.key !== row.key) {
      clearPending();
      const since = now;
      const cancel = schedule(() => {
        if (!pending || pending.key !== row.key || !last) return;
        update(last.y, last.rows, since + dwell);
      }, dwell);
      pending = { key: row.key, since, cancel };
    }
    if (now - pending.since >= dwell) {
      clearPending();
      return commit({ key: row.key, zone });
    }
    return current;
  };

  return {
    update,
    reset() {
      clearPending();
      current = null;
      last = null;
    },
    get current() {
      return current;
    },
  };
}

function layoutTop(element: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = element;
  while (node) {
    top += node.offsetTop;
    const parent = node.offsetParent as HTMLElement | null;
    if (parent) top += parent.clientTop;
    node = parent;
  }
  return top;
}

/**
 * The viewport box `element` has in layout, ignoring transforms (translate,
 * scale) on it and its ancestors below `root`. `root` must not be transformed
 * and must share the element's scroll container.
 */
export function measureDropBox(element: HTMLElement, root: HTMLElement): DropZoneBox {
  return {
    top: root.getBoundingClientRect().top + layoutTop(element) - layoutTop(root),
    height: element.offsetHeight,
  };
}
