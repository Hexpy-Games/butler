import { expect, test } from "bun:test";
import { interleaveDashboardLanes } from "../../packages/butler-agent/src/gateways/app/domain/projects/project-dashboard-board.ts";
import type { DashboardBoardCard } from "../../packages/butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";

test("a recent completed-work backlog cannot hide active or blocked lanes on the first page", () => {
  const card = (id: string, lane: DashboardBoardCard["lane"]): DashboardBoardCard => ({
    id, lane, kind: "work", title: id, status: "open", parentId: null, updatedAt: "2026-09-09",
    taskProgress: null, actionProgress: null, session: null,
  });
  const recent = Array.from({ length: 100 }, (_, index) => card(`done-${index}`, "done"));
  const active = Array.from({ length: 29 }, (_, index) => card(`active-${index}`, "active"));
  const result = interleaveDashboardLanes([...recent, ...active, card("blocked", "blocked")]);
  expect(result.slice(0, 50).some((item) => item.lane === "active")).toBe(true);
  expect(result.slice(0, 50).some((item) => item.lane === "blocked")).toBe(true);
  expect(result.filter((item) => item.lane === "done")).toEqual(recent);
  expect(result.filter((item) => item.lane === "active")).toEqual(active);
  expect(new Set(result.map((item) => item.id)).size).toBe(130);
  expect(result.slice(0, 50).concat(result.slice(50, 100), result.slice(100))).toEqual(result);
});
