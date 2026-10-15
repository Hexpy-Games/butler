// test-category: pure-logic
import { afterEach, expect, test } from "bun:test";
import { appCopy, setAppCopyLanguage } from "@/app/copy";
import { usageBucketLabel, usageShare } from "./usageTimeline";

afterEach(() => setAppCopyLanguage("en-US"));
const hour = (day: number, value: number) => new Date(2026, 9, day, value).getTime();

test("same-day hourly selection omits the date; wider bars retain their range", () => {
  setAppCopyLanguage("ko-KR");
  expect(usageBucketLabel(hour(15, 14), hour(15, 15), hour(15, 14) + 1, 1)).toBe("14시 · 진행 중");
  expect(usageBucketLabel(hour(15, 14), hour(15, 16), hour(15, 17), 2)).toBe("14–16시");
  expect(usageBucketLabel(hour(14, 14), hour(14, 15), hour(15, 17), 1)).toBe("10월 14일 14–15시");
});

test("English selected hours use a native 24-hour range", () => {
  expect(usageBucketLabel(hour(15, 14), hour(15, 15), hour(15, 14) + 1, 1)).toBe("14:00 · Now");
  expect(usageBucketLabel(hour(15, 14), hour(15, 16), hour(15, 17), 2)).toBe("14:00–16:00");
});

test("small positive shares stay visible and zero stays zero", () => {
  expect(usageShare(0.0001)).toBe("Less than 1%");
  expect(usageShare(0)).toBe("0%");
  setAppCopyLanguage("ko-KR");
  expect(usageShare(0.0099)).toBe("1% 미만");
});

test("request and failure copy handles English singular and zero", () => {
  expect(appCopy.composer.usage.requests("1")).toBe("1 request");
  expect(appCopy.composer.usage.requests("2")).toBe("2 requests");
  expect(appCopy.composer.usage.failures("0")).toBe("No failures");
});
