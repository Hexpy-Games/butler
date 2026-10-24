// test-category: pure-logic
import { describe, expect, test } from "bun:test";
import { ASIDE_DOCK_HYSTERESIS, nextAsideLayout } from "./asideLayout";

describe("nextAsideLayout", () => {
  test("first measure docks from the line and floats below it", () => {
    expect(nextAsideLayout(null, 960, 960)).toBe("docked");
    expect(nextAsideLayout(null, 959, 960)).toBe("floating");
  });

  test("a docked aside stays docked down to the line", () => {
    expect(nextAsideLayout("docked", 960, 960)).toBe("docked");
    expect(nextAsideLayout("docked", 959, 960)).toBe("floating");
  });

  test("a floating aside docks again only past the hysteresis, so a width on the line never flaps", () => {
    expect(nextAsideLayout("floating", 960, 960)).toBe("floating");
    expect(nextAsideLayout("floating", 960 + ASIDE_DOCK_HYSTERESIS - 1, 960)).toBe("floating");
    expect(nextAsideLayout("floating", 960 + ASIDE_DOCK_HYSTERESIS, 960)).toBe("docked");
  });
});
