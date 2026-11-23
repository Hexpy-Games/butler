// test-category: pure-logic
import { expect, test } from "bun:test";
import { GatewayError } from "../../../butler-protocol/src/client/envelope.ts";
import { newDraft, saveError, savePayload, withCustomMinutes, withFrequency, withInterval } from "./automationForm";

test("withFrequency keeps time and timezone when switching from daily to weekdays", () => {
  const draft = { ...newDraft("general", "auto"), scheduleType: "daily",
    schedule: { kind: "daily", time: "09:30", weekdays: [], tz: "Asia/Seoul" } };
  expect(withFrequency(draft, "weekdays").schedule)
    .toEqual({ kind: "weekly", time: "09:30", weekdays: [1, 2, 3, 4, 5], tz: "Asia/Seoul" });
});

test("withCustomMinutes keeps a preset number of minutes custom", () => {
  const draft = withCustomMinutes(withInterval(newDraft("general", "auto"), "custom"), "10");
  expect(draft.customInterval).toBe(true);
  expect(draft.intervalSeconds).toBe(600);
});

test("savePayload includes model only when changed", () => {
  const draft = newDraft("general", "auto");
  expect(savePayload(draft)).not.toHaveProperty("model");
  expect(savePayload({ ...draft, model: "model" }).model).toBe("model");
});

test("saveError maps gateway errors to fields", () => {
  expect(saveError(new GatewayError(400, "automation_title_required", ""))).toBe("title");
  expect(saveError(new GatewayError(400, "http_400", ""))).toBe("form");
  expect(saveError(new GatewayError(500, "http_500", ""))).toBeNull();
});
