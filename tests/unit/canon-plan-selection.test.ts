// test-category: pure-logic
import { expect, test } from "bun:test";
import type { CanonPlan } from "../../packages/butler-app/client/shared/canon-contracts.ts";
import { defaultCanonPlan } from "../../packages/butler-app/client/ui/src/components/canon/canonPlanSelection.ts";
const plan = (id: string, due_on: string | null, updated_at: number, status: "open" | "closed" = "open"): CanonPlan => ({
  id, due_on, updated_at, status, project_id: "project", title: id, description: "", revision: 1,
});
const today = new Date(2030, 5, 10);
test("default selects nearest future due date including today, regardless of API order", () => {
  expect(defaultCanonPlan([plan("later", "2030-06-20", 9), plan("past", "2030-06-09", 20),
    plan("today", "2030-06-10", 1), plan("closed", "2030-06-10", 30, "closed")], today)).toBe("today");
});
test("without future dates uses actual most recently updated open plan", () => {
  expect(defaultCanonPlan([plan("old", null, 10), plan("new", "2030-06-01", 20),
    plan("closed", null, 30, "closed")], today)).toBe("new");
});
test("without open plans uses backlog", () => {
  expect(defaultCanonPlan([], today)).toBeNull();
  expect(defaultCanonPlan([plan("closed", null, 30, "closed")], today)).toBeNull();
});
