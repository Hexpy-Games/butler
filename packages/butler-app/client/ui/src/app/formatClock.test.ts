import { expect, test } from "bun:test";
import { formatClock } from "./formatClock";

const now = new Date(2026, 8, 25, 18, 0, 0);

test("today's times read hour and two-digit minute in the app locale", () => {
  const time = new Date(2026, 8, 25, 13, 25);
  expect(formatClock(time, "en-US", now)).toBe(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(time),
  );
  expect(formatClock(time, "en-US", now)).toMatch(/^1:25\s?PM$/u);
  expect(formatClock(time, "ko-KR", now)).toMatch(/^오후 1:25$/u);
  expect(formatClock(new Date(2026, 8, 25, 9, 5), "en-US", now)).toMatch(/^9:05\s?AM$/u);
});

test("the hour never gets a leading zero", () => {
  const morning = new Date(2026, 8, 25, 1, 25);
  expect(formatClock(morning, "en-US", now)).not.toMatch(/^0/u);
  expect(formatClock(morning, "ko-KR", now)).not.toContain("01:");
});

test("earlier days prepend month and day, earlier years also the year", () => {
  const earlier = new Date(2026, 8, 20, 13, 25);
  expect(formatClock(earlier, "en-US", now)).toContain("Sep 20");
  expect(formatClock(earlier, "en-US", now)).not.toContain("2026");
  const lastYear = new Date(2025, 11, 31, 13, 25);
  expect(formatClock(lastYear, "en-US", now)).toContain("2025");
});
