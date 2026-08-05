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

export function normalizeProjectLedgerCommitEvidenceInput(input: {
  toolName: string;
  args: Record<string, unknown>;
  workspacePath?: string;
}): Record<string, unknown> {
  if (input.toolName !== "project_ledger_work_complete") return input.args;
  const codeCommit = stringValue(input.args.code_commit);
  const codeCommits = stringValue(input.args.code_commits);
  if (!codeCommit && !codeCommits) return input.args;

  const mustCollect = codeCommit === "auto" ||
    !hasCanonicalCommitEvidenceArray(codeCommits);
  if (mustCollect && !input.workspacePath?.trim()) {
    throw new GitEvidenceCollectionError(
      "git_evidence_failed",
      "The active project workspace is required to collect Git commit evidence.",
    );
  }
  const normalized: Record<string, unknown> = {
    ...input.args,
    code_commits: mustCollect
      ? JSON.stringify([collectGitCommitEvidence(input.workspacePath!)])
      : codeCommits,
  };
  delete normalized.code_commit;
  return normalized;
}

function hasCanonicalCommitEvidenceArray(value: string): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => {
      const record = recordValue(item);
      return hasText(record.repo) && hasText(record.hash) && hasText(record.message);
    });
  } catch {
    return false;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
