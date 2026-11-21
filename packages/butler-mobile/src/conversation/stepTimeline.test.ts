// test-category: pure-logic
import { expect, test } from "bun:test";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import type { ProgressSummaryRow, WorkPlan } from "../../../butler-protocol/src/index.ts";
import { projectActivities, type Activity } from "./activityProjection";
import { stepTimeline } from "./stepTimeline";

test("stepTimeline groups activities before, within and after plan steps", () => {
  const plan: WorkPlan = { revision: 1, revisions: [], actions: [
    { action_key: "a", order: 1, title: "A", purpose: "A", status: "done", started_at: "2026-11-21T00:02:00Z", added_in_revision: 1 },
    { action_key: "b", order: 2, title: "B", purpose: "B", status: "done", added_in_revision: 1 },
  ] };
  const activities: (Activity & { actionKey?: string })[] = [
    { id: "T1", title: "Before", summary: "Before", createdAt: "2026-11-21T00:01:00Z", operations: [] },
    { id: "a", title: "A", summary: "A", actionKey: "a", operations: [] },
    { id: "b", title: "B", summary: "B", actionKey: "b", operations: [] },
    { id: "T3", title: "After", summary: "After", createdAt: "2026-11-21T00:03:00Z", operations: [] },
  ];
  const grouped = stepTimeline(activities, plan, []);
  expect(grouped.before).toEqual([activities[0]]);
  expect(grouped.steps[0].activities).toEqual([activities[1]]);
  expect(grouped.steps[1].activities).toEqual([activities[2]]);
  expect(grouped.after).toEqual([activities[3]]);
});

test("stepTimeline puts an adding revision before its step and remaining revisions after steps", () => {
  const plan: WorkPlan = { revision: 2, actions: [
    { action_key: "a", order: 1, title: "A", purpose: "A", status: "done", added_in_revision: 1 },
    { action_key: "b", order: 2, title: "B", purpose: "B", status: "done", added_in_revision: 2 },
  ], revisions: [
    { revision: 1, at: "2026-11-21T00:01:00Z", added: ["a"], removed: [] },
    { revision: 2, at: "2026-11-21T00:02:00Z", added: ["b"], removed: [], reason: "r" },
  ] };
  const grouped = stepTimeline([], plan, []);
  expect(grouped.steps[1].revision).toEqual(plan.revisions[1]);
  expect(grouped.trailingRevisions).toEqual([]);
  const revision = { revision: 3, at: "2026-11-21T00:03:00Z", added: [], removed: [] };
  expect(stepTimeline([], { ...plan, revision: 3, revisions: [...plan.revisions, revision] }, []).trailingRevisions).toEqual([revision]);
});

test("projectActivities merges ordinary operations into one localized fallback activity", () => {
  const rows: ProgressSummaryRow[] = [
    { id: "first", kind: "used_tool", safe_label: "Read", state: "running", created_at: "2026-11-21T00:01:00Z", bridge_phase: "btcc_operation", tool_call_id: "read" },
    { id: "result", kind: "used_tool", safe_label: "Read", state: "delivered", created_at: "2026-11-21T00:02:00Z", bridge_phase: "btcc_operation", tool_call_id: "read" },
    { id: "other", kind: "used_tool", safe_label: "Search", state: "delivered", created_at: "2026-11-21T00:03:00Z", bridge_phase: "btcc_operation", tool_call_id: "search" },
  ];
  const { activities } = projectActivities(rows, "turn", "ko-KR");
  expect(activities).toHaveLength(1);
  expect(activities[0].title).toBe(getAppCopy("ko-KR").interfaceStatus.working);
  expect(activities[0].operations).toHaveLength(2);
});
