import { spawnSync } from "node:child_process";

export type GitCommandResult = {
  status: number | null;
  error?: Error;
};

export type GitCommandRunner = (
  command: string,
  args: string[],
) => GitCommandResult;

const runGitCommand: GitCommandRunner = (command, args) => {
  const result = spawnSync(command, args, {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  return {
    status: result.status,
    error: result.error,
  };
};

export function configureGitHooks(run: GitCommandRunner = runGitCommand): boolean {
  const repository = run("git", ["rev-parse", "--git-dir"]);
  if (repository.error || repository.status !== 0) return false;

  const configured = run("git", ["config", "core.hooksPath", ".githooks"]);
  return !configured.error && configured.status === 0;
}

if (import.meta.main) configureGitHooks();
