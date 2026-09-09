import { expect, test } from "bun:test";
import { relativeActivity } from "./row-details";

test("relative last activity covers now, minutes, hours and previous days", () => {
  const now = 1_000_000_000;
  expect(relativeActivity(now, now)).toBe("방금");
  expect(relativeActivity(now + 100, now)).toBe("방금");
  expect(relativeActivity(now - 3 * 60_000, now)).toBe("3분 전");
  expect(relativeActivity(now - 2 * 3_600_000, now)).toBe("2시간 전");
  expect(relativeActivity(now - 86_400_000, now)).toBe("어제");
});
