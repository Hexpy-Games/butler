import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { CliError } from "./errors.js";

export function gitCommitEvidence(repoPath) {
  const topLevel = git(repoPath, ["rev-parse", "--show-toplevel"]);
  const hash = git(topLevel, ["rev-parse", "--short=12", "HEAD"]);
  const message = git(topLevel, ["log", "-1", "--format=%s"]);
  const branch = git(topLevel, ["branch", "--show-current"]);
  const committedAt = git(topLevel, ["log", "-1", "--format=%cI"]);
  return {
    repo: basename(topLevel),
    hash,
    message,
    branch: branch || "detached",
    committedAt,
  };
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) {
    throw new CliError(
      `Unable to collect git commit evidence: ${result.stderr.trim() || result.error?.message || args.join(" ")}`,
      "git_evidence_failed",
      1,
    );
  }
  return result.stdout.trim();
}
