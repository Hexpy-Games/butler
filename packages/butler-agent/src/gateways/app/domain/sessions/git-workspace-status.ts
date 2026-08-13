import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const GIT_INSPECTION_TIMEOUT_MS = 1_500;
const MAX_PUBLIC_BRANCH_LENGTH = 80;

export interface GitWorkspaceSummaryOptions {
  includeDirty?: boolean;
  expectedBranch?: string;
  expectedRepositoryAnchorPath?: string;
}

export function resolveGitWorkspaceSummary(
  workspacePath: string,
  gitExecutable = process.env.BUTLER_GIT_EXECUTABLE?.trim() || "git",
  options: GitWorkspaceSummaryOptions = {},
) {
  if (!workspacePath || !existsSync(workspacePath)) {
    return {
      available: false,
      workspace_mode: "unknown" as const,
      safe_status: "Project workspace unavailable",
      safe_error_code: "git_workspace_unavailable",
    };
  }

  const availabilityProbe = runGit(gitExecutable, workspacePath, ["--version"]);
  if (isMissingExecutable(availabilityProbe.error)) {
    return {
      available: false,
      workspace_mode: "unknown" as const,
      safe_status: "Git is not installed",
      safe_error_code: "git_not_installed",
    };
  }
  if (availabilityProbe.error || availabilityProbe.status !== 0) {
    return {
      available: false,
      workspace_mode: "unknown" as const,
      safe_status: "Git workspace unavailable",
      safe_error_code: "git_workspace_unavailable",
    };
  }

  const workspaceProbe = runGit(gitExecutable, workspacePath, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (workspaceProbe.error) {
    return {
      available: false,
      workspace_mode: "unknown" as const,
      safe_status: "Git workspace unavailable",
      safe_error_code: "git_workspace_unavailable",
    };
  }
  if (workspaceProbe.status !== 0 || workspaceProbe.stdout.trim() !== "true") {
    return {
      available: false,
      workspace_mode: "folder" as const,
      safe_status: "Project workspace",
    };
  }

  const branch = runGit(gitExecutable, workspacePath, [
    "branch",
    "--show-current",
  ]);
  if (branch.error || branch.status !== 0) {
    return {
      available: false,
      workspace_mode: "unknown" as const,
      safe_status: "Git workspace unavailable",
      safe_error_code: "git_workspace_unavailable",
    };
  }
  const branchName = safeBranchName(branch.stdout);
  if (
    options.expectedBranch &&
    options.expectedRepositoryAnchorPath &&
    (!branchName || !isLinkedWorktreeAtExpectedAnchor({
      workspacePath,
      gitExecutable,
      expectedBranch: options.expectedBranch,
      expectedRepositoryAnchorPath: options.expectedRepositoryAnchorPath,
    }))
  ) {
    return {
      available: false,
      workspace_mode: "unknown" as const,
      safe_status: "Git workspace unavailable",
      safe_error_code: "git_workspace_unavailable",
    };
  }
  const summary = {
    available: true,
    workspace_mode: "git" as const,
    ...(branchName ? { branch_name: branchName } : {}),
    safe_status: branchName ? `Git branch ${branchName}` : "Detached HEAD",
  };
  if (!options.includeDirty) return summary;
  const status = runGit(gitExecutable, workspacePath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.error || status.status !== 0) {
    return {
      available: false,
      workspace_mode: "unknown" as const,
      safe_status: "Git workspace unavailable",
      safe_error_code: "git_workspace_unavailable",
    };
  }
  return {
    ...summary,
    dirty: Boolean(status.stdout),
  };
}

function isLinkedWorktreeAtExpectedAnchor(input: {
  workspacePath: string;
  gitExecutable: string;
  expectedBranch: string;
  expectedRepositoryAnchorPath: string;
}): boolean {
  const workspaceCommonDir = runGit(input.gitExecutable, input.workspacePath, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const anchorCommonDir = runGit(
    input.gitExecutable,
    input.expectedRepositoryAnchorPath,
    ["rev-parse", "--git-common-dir"],
  );
  if (
    workspaceCommonDir.error ||
    workspaceCommonDir.status !== 0 ||
    anchorCommonDir.error ||
    anchorCommonDir.status !== 0
  ) {
    return false;
  }
  if (
    canonicalPath(resolve(input.workspacePath, workspaceCommonDir.stdout.trim())) !==
    canonicalPath(resolve(input.expectedRepositoryAnchorPath, anchorCommonDir.stdout.trim()))
  ) {
    return false;
  }
  const worktrees = runGit(
    input.gitExecutable,
    input.expectedRepositoryAnchorPath,
    ["worktree", "list", "--porcelain", "-z"],
  );
  if (worktrees.error || worktrees.status !== 0) return false;
  let fields: string[] = [];
  const records: string[][] = [];
  for (const field of worktrees.stdout.split("\0")) {
    if (!field) {
      if (fields.length > 0) records.push(fields);
      fields = [];
    } else {
      fields.push(field);
    }
  }
  if (fields.length > 0) records.push(fields);
  return records.some((record) => {
      const lines = record.flatMap((field) => field.split(/\r?\n/u));
      const path = lines.find((line) => line.startsWith("worktree "))
        ?.slice("worktree ".length);
      const branch = lines.find((line) => line.startsWith("branch "))
        ?.slice("branch ".length);
      return Boolean(
        path &&
        branch === `refs/heads/${input.expectedBranch}` &&
        canonicalPath(path) === canonicalPath(input.workspacePath),
      );
    });
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function runGit(executable: string, cwd: string, args: string[]) {
  return spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_INSPECTION_TIMEOUT_MS,
    windowsHide: true,
  });
}

function isMissingExecutable(error: Error | undefined): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function safeBranchName(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .slice(0, MAX_PUBLIC_BRANCH_LENGTH)
    .join("")
    .trim();
}
