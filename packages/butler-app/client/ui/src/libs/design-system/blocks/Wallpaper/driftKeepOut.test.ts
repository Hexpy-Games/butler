// test-category: pure-logic
import { expect, test } from "bun:test";
import { createDriftKeepOut } from "./driftKeepOut";
import { RISO_INTRO_BEAT_MS } from "./intro/introWake";

const rect = (x: number, height: number) => ({ x, y: 100, width: 520, height });

test("a moved setup card eases the keep-out over the print beat, then rests on the content rect", () => {
  let resting = rect(215, 300);
  const keep = createDriftKeepOut(() => resting);
  expect(keep.move(rect(215, 500), rect(215, 300), 0)).toBe(true);
  expect(keep.moving()).toBe(true);
  const middle = keep.current(RISO_INTRO_BEAT_MS / 2)!;
  expect(middle.height).toBeLessThan(500);
  expect(middle.height).toBeGreaterThan(300);
  expect(keep.current(RISO_INTRO_BEAT_MS)).toBe(resting);
  expect(keep.moving()).toBe(false);
  resting = rect(165, 300);
  expect(keep.move(rect(165, 300), rect(165, 300), 1000)).toBe(false);
});

test("a second move starts from where the running ease is; clear ends it at once", () => {
  const keep = createDriftKeepOut(() => rect(0, 0));
  keep.move(rect(0, 100), rect(0, 300), 0);
  const at = keep.current(RISO_INTRO_BEAT_MS / 3)!.height;
  keep.move(rect(0, 100), rect(0, 600), RISO_INTRO_BEAT_MS / 3);
  expect(keep.current(RISO_INTRO_BEAT_MS / 3)!.height).toBeCloseTo(at, 5);
  keep.clear();
  expect(keep.moving()).toBe(false);
  expect(keep.current(RISO_INTRO_BEAT_MS / 2)!.height).toBe(0);
});
