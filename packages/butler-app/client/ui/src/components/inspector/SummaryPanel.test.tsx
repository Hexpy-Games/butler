/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionSummaryView } from "@/app/types.ts";
import { SummaryPanel } from "./SummaryPanel.tsx";

test("summary uses only a real Git branch and removes transcript export", () => {
  const html = renderSummary({
    branch_info: {
      available: true,
      workspace_mode: "git",
      branch_name: "main",
      safe_status: "Git branch main",
    },
  });

  expect(html).toContain("Git branch");
  expect(html).toContain("main");
  expect(html).not.toContain("Git branch main");
  expect(html).not.toContain("Export app-visible transcript");
});

test("summary distinguishes detached Git and non-Git folders", () => {
  const detached = renderSummary({
    branch_info: {
      available: true,
      workspace_mode: "git",
      safe_status: "Detached HEAD",
    },
  });
  const folder = renderSummary({
    branch_info: {
      available: false,
      workspace_mode: "folder",
      safe_status: "Not a Git workspace",
    },
  });

  expect(detached).toContain("Detached HEAD");
  expect(folder).toContain("Not a Git workspace");
  expect(folder).not.toContain("Project workspace");
});

test("summary gives explicit values for no-project and unavailable workspaces", () => {
  expect(
    renderSummary({
      branch_info: {
        available: false,
        workspace_mode: "none",
        safe_status: "No project workspace",
      },
    }),
  ).toContain("No project workspace");
  expect(
    renderSummary({
      branch_info: {
        available: false,
        workspace_mode: "unknown",
        safe_error_code: "git_not_installed",
        safe_status: "Git is not installed",
      },
    }),
  ).toContain("Git is not installed");
  expect(
    renderSummary({
      branch_info: {
        available: false,
        workspace_mode: "unknown",
        safe_error_code: "git_workspace_unavailable",
        safe_status: "Git workspace unavailable",
      },
    }),
  ).toContain("Unavailable");
});

test("summary exposes session worktree identity and dirty state without paths", () => {
  const clean = renderSummary({
    branch_info: {
      available: true,
      workspace_mode: "git",
      branch_name: "feature/demo",
      safe_status: "Git branch feature/demo",
      workspace_binding: "session_worktree",
      workspace_label: "session-worktree/feature/demo",
      workspace_status: "available",
      dirty: false,
    },
  });
  expect(clean).toContain("Linked worktree");
  expect(clean).toContain("session-worktree/feature/demo");
  expect(clean).toContain("Clean");
  expect(clean).not.toContain("/tmp/");

  const dirty = renderSummary({
    branch_info: {
      available: true,
      workspace_mode: "git",
      branch_name: "feature/demo",
      safe_status: "Git branch feature/demo",
      workspace_binding: "session_worktree",
      workspace_label: "session-worktree/feature/demo",
      workspace_status: "available",
      dirty: true,
    },
  });
  expect(dirty).toContain("Dirty");

  const unavailable = renderSummary({
    branch_info: {
      available: false,
      workspace_mode: "unknown",
      safe_status: "Session worktree unavailable",
      safe_error_code: "session_workspace_unavailable",
      workspace_binding: "session_worktree",
      workspace_label: "Session worktree",
      workspace_status: "unavailable",
    },
  });
  expect(unavailable).toContain("Session worktree unavailable");
  expect(unavailable).toContain("Unavailable");
});

test("summary keeps project Git dependency status distinct from worktree failure", () => {
  const html = renderSummary({
    branch_info: {
      available: false,
      workspace_mode: "unknown",
      safe_status: "Git is not installed",
      safe_error_code: "git_not_installed",
      workspace_binding: "project",
      workspace_label: "Project workspace",
      workspace_status: "unavailable",
    },
  });
  expect(html).toContain("Project · Project workspace");
  expect(html).not.toContain("Session worktree unavailable");
  expect(html).toContain("Git is not installed");
});

test("summary maps canonical progress state families to distinguishable DS tones", () => {
  const familyMarkup = new Map<string, string>();
  const families: Record<string, string[]> = {
    complete: ["delivered", "complete", "completed"],
    running: [
      "accepted",
      "active",
      "thinking",
      "running",
      "streaming",
      "reviewing",
      "correction_required",
      "waiting_for_tool",
      "retrying",
    ],
    failed: ["failed"],
    cancelled: ["cancelled", "stopped"],
    idle: ["unknown"],
  };
  for (const [family, states] of Object.entries(families)) {
    const [first, ...rest] = states;
    const markup = renderSummaryWithProgress(first!);
    familyMarkup.set(family, markup);
    expect(markup).toContain("summary-progress-panel");
    for (const state of rest) {
      expect(renderSummaryWithProgress(state)).toBe(markup);
    }
  }
  expect(familyMarkup.get("running")).not.toBe(familyMarkup.get("complete"));
  expect(familyMarkup.get("idle")).not.toBe(familyMarkup.get("running"));
});

function renderSummary(
  branch: Pick<SessionSummaryView, "branch_info">,
): string {
  return renderToStaticMarkup(
    <SummaryPanel
      status={{ label: "Connected", tone: "ok" }}
      summary={{
        ...branch,
        latest_progress: { safe_progress_rows: [] },
        skills_used: [],
      }}
    />,
  );
}

function renderSummaryWithProgress(state: string): string {
  return renderToStaticMarkup(
    <SummaryPanel
      status={{ label: "Connected", tone: "ok" }}
      summary={{
        branch_info: {
          available: false,
          workspace_mode: "none",
          safe_status: "No project workspace",
        },
        latest_progress: {
          safe_progress_rows: [
            {
              id: "task",
              kind: "todo",
              state,
              safe_label: "Task",
              bridge_phase: "btcc_work_ledger",
            },
          ],
        },
        skills_used: [],
      }}
    />,
  );
}
