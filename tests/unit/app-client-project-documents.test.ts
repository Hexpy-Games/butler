import { expect, test } from "bun:test";
import {
  PLAN_BOARD_TABS,
  planBoardType,
  projectDocumentBadgeLabel,
  projectDocumentMarkdownView,
} from "../../packages/butler-app/client/ui/src/app/projectDocuments.ts";
import type { ProjectDashboardDocument } from "../../packages/butler-app/client/ui/src/app/types.ts";

test("project document markdown view lifts frontmatter into structured metadata", () => {
  const view = projectDocumentMarkdownView(`---
schema: "project-ledger.spec.v1"
kind: "spec"
id: "SPEC-1"
title: "Hidden duplicate title"
status: "active"
updatedAt: "2026-05-18T10:00:00Z"
---

# Visible title

Body text.`);

  expect(view.body).toBe("# Visible title\n\nBody text.");
  expect(view.frontmatter).toEqual([
    { key: "kind", label: "Kind", value: "spec" },
    { key: "id", label: "ID", value: "SPEC-1" },
    { key: "status", label: "Status", value: "active" },
    {
      key: "updatedAt",
      label: "Updated",
      value: "2026-05-18T10:00:00Z",
    },
  ]);
});

test("project document markdown view leaves plain markdown untouched", () => {
  const view = projectDocumentMarkdownView("# Plain\n\nNo metadata.");
  expect(view.body).toBe("# Plain\n\nNo metadata.");
  expect(view.frontmatter).toEqual([]);
});

function projectDocument(
  documentType: ProjectDashboardDocument["document_type"],
): ProjectDashboardDocument {
  return {
    id: `${documentType}:fixture`,
    kind: documentType === "spec" ? "spec" : "plan",
    document_type: documentType,
    title: `${documentType} fixture`,
    safe_path_label: `.project-ledger/${documentType}/fixture.md`,
    markdown: `# ${documentType} fixture`,
    updated_at: "2026-05-23T00:00:00.000Z",
  };
}

test("project dashboard keeps top-level plans separate from work records", () => {
  expect(PLAN_BOARD_TABS.map((tab) => tab.id)).toEqual([
    "plan",
    "work",
    "task",
  ]);
  expect(planBoardType(projectDocument("plan"))).toBe("plan");
  expect(planBoardType(projectDocument("work"))).toBe("work");
  expect(planBoardType(projectDocument("task"))).toBe("task");
  expect(projectDocumentBadgeLabel(projectDocument("plan"))).toBe("Plan");
  expect(projectDocumentBadgeLabel(projectDocument("work"))).toBe("Work");
  expect(projectDocumentBadgeLabel(projectDocument("task"))).toBe("Task");
});
