// test-category: pure-logic
import { expect, test } from "bun:test";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { runLabel, scheduleFrequency } from "./automationLabels";

test("scheduleFrequency", () => {
  const ko = getAppCopy("ko-KR").automations, en = getAppCopy("en-US").automations;
  expect(scheduleFrequency({ schedule: null, schedule_type: "interval", interval_seconds: 7200 }, ko, "ko-KR")).toBe("2시간마다");
  expect(scheduleFrequency({ schedule: null, schedule_type: "interval", interval_seconds: 900 }, ko, "ko-KR")).toBe("15분마다");
  expect(scheduleFrequency({ schedule: null, schedule_type: "once", interval_seconds: 0 }, ko, "ko-KR")).toBe("한 번");
  expect(scheduleFrequency({ schedule: { kind: "weekly", time: "09:00", weekdays: [1, 2, 3, 4, 5], tz: "UTC" },
    schedule_type: "weekly", interval_seconds: 0 }, en, "en-US").replace(/\s/gu, " ")).toBe("Every weekday at 9:00 AM");
});

test("runLabel", () => {
  const copy = getAppCopy("en-US").automations.runs;
  expect(runLabel({ state: "succeeded" }, copy)).toBe("Succeeded");
  expect(runLabel({ state: "failed", safe_error_code: "schedule_permission_required" }, copy)).toBe("Needs permission");
  expect(runLabel({ state: "other" }, copy)).toBe("Not run yet");
});
