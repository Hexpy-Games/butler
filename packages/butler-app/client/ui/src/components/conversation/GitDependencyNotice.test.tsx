import { expect, test } from "bun:test";
import type { SessionSummaryView } from "@/app/types.ts";
import { shouldShowGitDependencyNotice } from "./GitDependencyNotice";

test("Git installation guidance appears only for the missing capability", () => {
  expect(shouldShowGitDependencyNotice({
      branch_info: { safe_error_code: "git_not_installed" },
    } as SessionSummaryView)).toBe(true);

  expect(shouldShowGitDependencyNotice({
      branch_info: { safe_error_code: "git_workspace_unavailable" },
    } as SessionSummaryView)).toBe(false);
  expect(shouldShowGitDependencyNotice(null)).toBe(false);
});
