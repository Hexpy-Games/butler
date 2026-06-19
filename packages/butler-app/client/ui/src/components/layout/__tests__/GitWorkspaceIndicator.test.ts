import { gitWorkspaceIndicatorModel } from "../GitWorkspaceIndicator.tsx";
import type { GitWorkspaceView } from "@/app/types.ts";

function gitWorkspace(overrides: Partial<GitWorkspaceView> = {}): GitWorkspaceView {
  return {
    available: true,
    workspaceMode: "git-repository",
    workspacePath: "/Users/example/full/path",
    repoRoot: "/Users/example/full/path",
    branch: "main",
    headSha: "abcdef1234567890",
    detached: false,
    dirty: false,
    capturedAt: "2026-06-18T00:00:00.000Z",
    ...overrides,
  };
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertNotIncludes(actual: string, unexpected: string, message: string): void {
  if (actual.includes(unexpected)) {
    throw new Error(`${message}: unexpectedly included ${unexpected}`);
  }
}

assertEqual(gitWorkspaceIndicatorModel(), null, "absent metadata returns null");

const branch = gitWorkspaceIndicatorModel(gitWorkspace({ branch: "feature/test" }));
assertEqual(branch?.label, "feature/test", "branch label is compact");
assertEqual(branch?.title, "Git workspace: feature/test (repo)", "branch title is compact");
assertNotIncludes(`${branch?.label} ${branch?.title}`, "/Users/example/full/path", "branch model hides full paths");

const worktree = gitWorkspaceIndicatorModel(gitWorkspace({
  branch: "feature/worktree",
  dirty: true,
  isLinkedWorktree: true,
  workspaceMode: "git-worktree",
  worktreePath: "/Users/example/worktrees/feature",
}));
assertEqual(worktree?.label, "feature/worktree* worktree", "worktree dirty label is compact");
assertEqual(worktree?.title, "Git workspace: feature/worktree (worktree, dirty)", "worktree title includes state");
assertEqual(worktree?.tone, "warning", "dirty worktree uses warning tone");
assertNotIncludes(`${worktree?.label} ${worktree?.title}`, "/Users/example/worktrees/feature", "worktree model hides full paths");

const detached = gitWorkspaceIndicatorModel(gitWorkspace({ detached: true, branch: undefined }));
assertEqual(detached?.label, "abcdef1", "detached label uses short sha");
assertEqual(detached?.title, "Git workspace: detached abcdef1 (repo)", "detached title includes state");
assertEqual(detached?.tone, "warning", "detached state uses warning tone");

assertEqual(gitWorkspaceIndicatorModel(gitWorkspace({ available: false, workspaceMode: "none" }))?.label, "non-git", "none state label");
assertEqual(gitWorkspaceIndicatorModel(gitWorkspace({ available: false, workspaceMode: "folder" }))?.label, "non-git", "folder state label");
assertEqual(gitWorkspaceIndicatorModel(gitWorkspace({ available: false, workspaceMode: "unknown" }))?.label, "unknown", "unknown state label");
assertEqual(gitWorkspaceIndicatorModel(gitWorkspace({ available: false, workspaceMode: "unknown" }))?.tone, "warning", "unknown state tone");
