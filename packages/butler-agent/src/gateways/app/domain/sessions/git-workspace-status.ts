import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const GIT_INSPECTION_TIMEOUT_MS = 1_500;
const MAX_PUBLIC_BRANCH_LENGTH = 80;

export function resolveGitWorkspaceSummary(
  workspacePath: string,
  gitExecutable = process.env.BUTLER_GIT_EXECUTABLE?.trim() || "git",
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
  return {
    available: true,
    workspace_mode: "git" as const,
    ...(branchName ? { branch_name: branchName } : {}),
    safe_status: branchName ? `Git branch ${branchName}` : "Detached HEAD",
  };
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
