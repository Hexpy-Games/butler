// test-category: pure-logic
import { expect, test } from "bun:test";
import { getAppCopy } from "../../../../../../butler-i18n/src";
import type { UsageHistoryView } from "@/app/types";
import { dailyLevels, durationMinutes, historyDate, historyWindow, localeWeekStart } from "./usageHistoryModel";

function history(days: [string, number][], priorTotal = 0): UsageHistoryView {
  return { lifetimeTokens: priorTotal + days.reduce((a, [, b]) => a + b, 0),
    busiestDay: null, longestTask: null, longestStreak: { days: 0, start: null, end: null },
    currentStreak: { days: 23, start: "2026-09-02" }, days, priorTotal,
    firstActiveDate: days.find(([, value]) => value > 0)?.[0] ?? null, timeZone: "Asia/Seoul" };
}

test("daily levels use the active median and log thirds, including equal and zero days", () => {
  expect(dailyLevels([0, 10, 10, 10])).toEqual([0, 1, 1, 1]);
  expect(dailyLevels([0, 0])).toEqual([0, 0]);
  expect(dailyLevels([])).toEqual([]);
  expect(dailyLevels([1, 1, 1, 1, 1, 2, 4, 8])).toEqual([1, 1, 1, 1, 1, 2, 3, 4]);
  expect(dailyLevels([1, 3, 6, 12])).toEqual([1, 1, 2, 4]);
  expect(dailyLevels([300, 300, 300, 600, 2000])).toEqual([1, 1, 1, 3, 4]);
});

test("Sunday and Monday starts produce exactly 53 aligned weeks ending in the current week", () => {
  const data = history([["2026-09-16", 1]]);
  for (const [start, first, last] of [[0, "2025-09-14", "2026-09-19"], [1, "2025-09-15", "2026-09-20"]] as const) {
    const grid = historyWindow(data, start, "2026-09-16");
    expect(grid.dates.length).toBe(371);
    expect(grid.weeks.length).toBe(53);
    expect(grid.dates[0]).toBe(first);
    expect(grid.dates.at(-1)).toBe(last);
    expect(grid.values.reduce((a, b) => a + b, 0)).toBe(1);
  }
  expect(localeWeekStart("en-US")).toBe(0);
  expect(localeWeekStart("en-GB")).toBe(1);
});

test("weekly heights fill bottom-up, preserve idle weeks, and show even tiny active weeks", () => {
  const data = history([["2026-09-01", 1], ["2026-09-08", 70], ["2026-09-16", 30]]);
  const grid = historyWindow(data, 0, "2026-09-16");
  expect(grid.weeklyHeights.slice(-4)).toEqual([0, 1, 7, 3]);
  expect(grid.cumulativeHeights.slice(-4)).toEqual([0, 1, 5, 7]);
  expect(data.currentStreak.days).toBe(23); // Client does not derive or reset the server's streak.
});

test("cumulative includes priorTotal and days before the aligned grid, and never drops on idle weeks", () => {
  const data = history([["2025-09-11", 20], ["2025-09-14", 10], ["2026-09-16", 70]], 100);
  const grid = historyWindow(data, 0, "2026-09-16");
  expect(grid.cumulative[0]).toBe(130);
  expect(grid.cumulative.at(-1)).toBe(200);
  expect(grid.cumulativeHeights[0]).toBe(5);
  expect(grid.cumulativeHeights.every((height, i, all) => i === 0 || height >= all[i - 1]!)).toBe(true);
  expect(grid.cumulativeHeights.at(-1)).toBe(7);
  expect(historyWindow(history([["2026-09-16", 0]]), 0, "2026-09-16").cumulativeHeights).toEqual(Array(53).fill(0));
});

test("durations and date labels use local units while calendar dates stay in the host day", () => {
  expect(durationMinutes(401, getAppCopy("ko-KR").composer.usage)).toBe("6시간 41분");
  expect(durationMinutes(401, getAppCopy("en-US").composer.usage)).toBe("6h 41m");
  expect(durationMinutes(0, getAppCopy("en-US").composer.usage)).toBe("0m");
  expect(historyDate("2026-09-14", "ko-KR")).toBe("9월 14일");
  expect(historyDate("2026-09-14", "en-US")).toBe("Sep 14");
});
