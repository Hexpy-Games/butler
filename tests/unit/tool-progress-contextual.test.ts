import { expect, test } from "bun:test";
import { contextualToolProgressSummary } from "../../packages/butler-agent/src/agent/output/progress/contextual.ts";

test("Project Ledger progress treats omitted project ref as active project", () => {
  const summary = contextualToolProgressSummary("inspect_project_status", {});

  expect(summary?.detailRows).toEqual([
    {
      id: "project-ledger-project",
      kind: "project",
      safe_label: "Project",
      safe_value: "active project",
      state: "running",
    },
  ]);
});

test("Project Ledger progress prefers project_ref over legacy project_path", () => {
  const summary = contextualToolProgressSummary("query_project_work", {
    project_ref: "sandy-bot",
    project_path: ["", "Users", "yeonwoo", "butler"].join("/"),
    kind: "next-actions",
  });

  expect(summary?.detailRows?.[0]).toEqual({
    id: "project-ledger-project",
    kind: "project",
    safe_label: "Project",
    safe_value: "sandy-bot",
    state: "running",
  });
});
