import { expect, test } from "bun:test";
import { readRepoOrLedgerFile } from "../support/project-ledger-root.ts";

test("feature roadmap status matches completed implementation slices", () => {
  const roadmap = readRepoOrLedgerFile("project-ledger/projects/butler/roadmaps/roadmap-todo.md");
  const featurePlan = readRepoOrLedgerFile("project-ledger/projects/butler/plans/plan-feature-roadmap.md");
  const projectMemoryPlan = readRepoOrLedgerFile(
    "project-ledger/projects/butler/plans/plan-project-memory-runtime.md",
  );
  const cliDeferredSpec = readRepoOrLedgerFile(
    "project-ledger/projects/butler/specs/cli/advanced-deferred-commands.md",
  );

  expect(roadmap).toContain("| 11 | Butler Product CLI | `docs/specs/butler-cli.md` | Completed |");
  expect(roadmap).toContain("| 12 | Project Memory Runtime | `docs/specs/project-memory-runtime.md` | Completed |");
  expect(roadmap).toContain("- [x] PM-4 memory engine promotion from repeated project-scoped signals");
  expect(roadmap).toContain("- [x] PM-5 health, migration, safe inspect diagnostics, and refresh failure");
  expect(roadmap).not.toMatch(/^- \[ \] CLI-/m);

  expect(featurePlan).toContain("| Project Memory Runtime | Completed |");
  expect(featurePlan).not.toContain("| Web Search Tool | Planned |");
  expect(featurePlan).not.toContain("| Butler Product CLI | Planned |");

  expect(projectMemoryPlan).toContain("## Phase PM-4: Memory Engine Promotion\n\nStatus: Complete.");
  expect(projectMemoryPlan).toContain("## Phase PM-5: Health, Migration, And Repair\n\nStatus: Complete.");
  expect(projectMemoryPlan).not.toContain("Status: Partially complete.");
  expect(projectMemoryPlan).not.toContain("Status: In progress.");

  expect(cliDeferredSpec).toMatch(/Deferred\s+commands are a negative product decision/);
  expect(cliDeferredSpec).toContain("not a promotion backlog");
});
