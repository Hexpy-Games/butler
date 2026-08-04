import { spawnSync } from "node:child_process";
import { basename } from "node:path";

export const GIT_INSTALL_URL = "https://git-scm.com/downloads";

export class GitEvidenceCollectionError extends Error {
  constructor(
    readonly code: "git_not_installed" | "git_evidence_failed",
    message: string,
  ) {
    super(message);
    this.name = "GitEvidenceCollectionError";
  }
}

export function collectGitCommitEvidence(
  workspacePath: string,
): Record<string, string> {
  const topLevel = gitText(workspacePath, ["rev-parse", "--show-toplevel"]);
  return {
    repo: basename(topLevel),
    hash: gitText(topLevel, ["rev-parse", "--short=12", "HEAD"]),
    message: gitText(topLevel, ["log", "-1", "--format=%s"]),
    branch: gitText(topLevel, ["branch", "--show-current"]) || "detached",
    committedAt: gitText(topLevel, ["log", "-1", "--format=%cI"]),
  };
}

function gitText(cwd: string, args: string[]): string {
  const executable = process.env.BUTLER_GIT_EXECUTABLE?.trim() || "git";
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code ===
        "ENOENT"
      ? "git_not_installed"
      : "git_evidence_failed";
    throw new GitEvidenceCollectionError(
      code,
      `Unable to collect Git commit evidence: ${result.stderr?.trim() || result.error?.message || args.join(" ")}`,
    );
  }
  return result.stdout.trim();
}
