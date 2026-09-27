/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  DROP_ZONE_COMBINE_DWELL,
  DROP_ZONE_HYSTERESIS,
  createDropZoneTracker,
  measureDropBox,
  resolveDropZone,
  type DropZoneCandidate,
  type DropZoneHit,
} from "./dropZones";

const ROW = { top: 100, height: 40 };

describe("resolveDropZone", () => {
  test("a combinable row splits 25% before, 50% combine, 25% after", () => {
    const zone = (y: number) => resolveDropZone(y, ROW, { combine: true });
    expect(zone(100)).toBe("before");
    expect(zone(109)).toBe("before");
    expect(zone(110)).toBe("combine");
    expect(zone(129)).toBe("combine");
    expect(zone(130)).toBe("after");
    expect(zone(139)).toBe("after");
  });

  test("a row that cannot combine splits in half; an expanded folder has no after zone", () => {
    expect(resolveDropZone(119, ROW, { combine: false })).toBe("before");
    expect(resolveDropZone(120, ROW, { combine: false })).toBe("after");
    expect(resolveDropZone(135, ROW, { combine: true, after: false })).toBe("combine");
    expect(resolveDropZone(135, ROW, { combine: false, after: false })).toBe("before");
  });

  test("hysteresis keeps the current zone until the pointer is past the boundary by the margin", () => {
    const rules = { combine: true };
    // Boundary before|combine is at 110.
    expect(resolveDropZone(110 + DROP_ZONE_HYSTERESIS - 1, ROW, rules, "before")).toBe("before");
    expect(resolveDropZone(110 + DROP_ZONE_HYSTERESIS, ROW, rules, "before")).toBe("combine");
    expect(resolveDropZone(110 - DROP_ZONE_HYSTERESIS + 1, ROW, rules, "combine")).toBe("combine");
    expect(resolveDropZone(110 - DROP_ZONE_HYSTERESIS - 1, ROW, rules, "combine")).toBe("before");
  });
});

function rows(combine = true): DropZoneCandidate<string>[] {
  // Three 40px rows with a 4px gap, like sidebar rows.
  return [
    { key: "a", top: 100, height: 40, combine },
    { key: "b", top: 144, height: 40, combine },
    { key: "c", top: 188, height: 40, combine },
  ];
}

function tracker(dwell = 0) {
  const changes: Array<DropZoneHit<string> | null> = [];
  const timers: Array<{ at: number; run: () => void }> = [];
  const instance = createDropZoneTracker<string>({
    dwell,
    onChange: (hit) => changes.push(hit),
    schedule: (run, delay) => {
      const timer = { at: delay, run };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
  });
  return { instance, changes, timers };
}

describe("createDropZoneTracker", () => {
  test("a pointer oscillating around a zone boundary does not flip the zone every frame", () => {
    const { instance, changes } = tracker();
    instance.update(105, rows(), 0);
    // +-2px jitter around the before|combine boundary of row b (154).
    for (let frame = 0; frame < 60; frame += 1) instance.update(frame % 2 ? 156 : 152, rows(), frame * 16);
    expect(changes.map((hit) => hit && `${hit.key}:${hit.zone}`)).toEqual(["a:before", "b:before"]);
  });

  test("a slow sweep across a row changes the zone once per boundary crossing", () => {
    const { instance, changes } = tracker();
    for (let y = 140; y <= 190; y += 0.5) instance.update(y, rows(), y);
    for (let y = 190; y >= 136; y -= 0.5) instance.update(y, rows(), 1000 + y);
    const sequence = changes.map((hit) => hit && `${hit.key}:${hit.zone}`);
    // Down: a:after -> b:before -> b:combine -> b:after -> c:before, then back up.
    expect(sequence).toEqual([
      "a:after", "b:before", "b:combine", "b:after", "c:before",
      "b:after", "b:combine", "b:before", "a:after",
    ]);
  });

  test("the current row keeps the pointer a few px past its edge", () => {
    const { instance, changes } = tracker();
    instance.update(138, rows(), 0);
    instance.update(142, rows(), 16); // in the gap, 2px past row a
    instance.update(140 + DROP_ZONE_HYSTERESIS, rows(), 32); // still within the margin
    expect(changes.map((hit) => hit?.key)).toEqual(["a"]);
    instance.update(146, rows(), 48);
    expect(changes.map((hit) => hit?.key)).toEqual(["a", "b"]);
  });

  test("entering combine waits for the dwell and keeps the previous feedback meanwhile", () => {
    const { instance, changes, timers } = tracker(DROP_ZONE_COMBINE_DWELL);
    instance.update(146, rows(), 0);
    instance.update(164, rows(), 20);
    expect(changes.map((hit) => hit && `${hit.key}:${hit.zone}`)).toEqual(["b:before"]);
    expect(timers).toHaveLength(1);
    // No further pointer events: the scheduled re-check commits the combine.
    timers[0]!.run();
    expect(changes.at(-1)).toEqual({ key: "b", zone: "combine" });
  });

  test("leaving the combine zone before the dwell cancels it", () => {
    const { instance, changes, timers } = tracker(DROP_ZONE_COMBINE_DWELL);
    instance.update(146, rows(), 0);
    instance.update(164, rows(), 20);
    instance.update(180, rows(), 60);
    expect(timers).toHaveLength(0);
    expect(changes.map((hit) => hit && `${hit.key}:${hit.zone}`)).toEqual(["b:before", "b:after"]);
  });

  test("a pointer far from every row clears the hit; reset forgets the state", () => {
    const { instance, changes } = tracker();
    instance.update(110, rows(false), 0);
    instance.update(400, rows(false), 16);
    expect(changes).toEqual([{ key: "a", zone: "before" }, null]);
    instance.update(120, rows(false), 32);
    instance.reset();
    expect(instance.current).toBeNull();
  });
});

describe("measureDropBox", () => {
  test("measures layout offsets, which translate and scale do not change", () => {
    const node = (offsetTop: number, offsetParent: unknown, offsetHeight = 0) =>
      ({ offsetTop, offsetParent, offsetHeight, clientTop: 0, getBoundingClientRect: () => ({ top: 50 }) }) as unknown as HTMLElement;
    const body = node(0, null);
    const root = node(20, body);
    const item = node(80, body);
    const header = node(6, item, 30);
    // The root's client top (50) anchors the layout offsets to the viewport.
    expect(measureDropBox(header, root)).toEqual({ top: 50 + (86 - 20), height: 30 });
  });
});
