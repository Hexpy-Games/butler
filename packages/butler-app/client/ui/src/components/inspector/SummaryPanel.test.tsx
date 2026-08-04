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
  expect(renderSummary({
    branch_info: { available: false, workspace_mode: "none", safe_status: "No project workspace" },
  })).toContain("No project workspace");
  expect(renderSummary({
    branch_info: {
      available: false,
      workspace_mode: "unknown",
      safe_error_code: "git_not_installed",
      safe_status: "Git is not installed",
    },
  })).toContain("Git is not installed");
  expect(renderSummary({
    branch_info: {
      available: false,
      workspace_mode: "unknown",
      safe_error_code: "git_workspace_unavailable",
      safe_status: "Git workspace unavailable",
    },
  })).toContain("Unavailable");
});

function renderSummary(branch: Pick<SessionSummaryView, "branch_info">): string {
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
