import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { mkdirSync } from "node:fs";

export type ToolRecord = Record<string, unknown>;

const GIT = process.env.BUTLER_GIT_EXECUTABLE?.trim() || "git";

export function initRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  runProcess(["init", "-q"], path);
  runProcess(["config", "user.email", "smoke@example.invalid"], path);
  runProcess(["config", "user.name", "Butler Smoke"], path);
  runProcess(["commit", "--allow-empty", "-qm", "smoke initial"], path);
}

export function initializeLedger(
  repoRoot: string,
  dataPath: string,
  projectId: string,
): void {
  const projectPath = join(dataPath, "project-ledger", "projects", projectId);
  mkdirSync(projectPath, { recursive: true });
  runProcess([
    join(repoRoot, "packages", "project-ledger", "bin", "project-ledger"),
    "init",
    "--id",
    projectId,
    "--name",
    projectId,
    "--project",
    projectPath,
    "--json",
  ], repoRoot, {
    env: { ...process.env, BUTLER_DATA: dataPath },
    executable: process.execPath,
  });
}

export function createLedgerWork(input: {
  repoRoot: string;
  dataPath: string;
  projectId: string;
  workId: string;
}): void {
  runProcess([
    join(input.repoRoot, "packages", "project-ledger", "bin", "project-ledger"),
    "work",
    "create",
    "--id",
    input.workId,
    "--title",
    "Standalone session workspace smoke",
    "--status",
    "in_progress",
    "--spec-exemption",
    "--acceptance-exemption",
    "--project",
    join(input.dataPath, "project-ledger", "projects", input.projectId),
    "--json",
  ], input.repoRoot, {
    env: { ...process.env, BUTLER_DATA: input.dataPath },
    executable: process.execPath,
  });
}

export function runProcess(
  args: string[],
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; executable?: string } = {},
): void {
  const result = spawnSync(options.executable ?? GIT, args, {
    cwd,
    ...(options.env ? { env: options.env } : {}),
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30_000,
  });
  if (result.status !== 0 || result.error) throw new Error("smoke_process_failed");
}

export function asRecord(value: unknown): ToolRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("smoke_tool_result_invalid");
  }
  return value as ToolRecord;
}

export function commitEvidence(value: ToolRecord): ToolRecord | null {
  const data = value.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const codeCommits = (data as ToolRecord).codeCommits;
  if (typeof codeCommits !== "string") return null;
  try {
    const parsed = JSON.parse(codeCommits) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const first = parsed[0];
    return first && typeof first === "object" && !Array.isArray(first)
      ? first as ToolRecord
      : null;
  } catch {
    return null;
  }
}

export function assertCommitEvidence(
  evidence: ToolRecord | null,
  workspacePath: string,
  branch: string,
): void {
  if (!evidence) throw new Error("smoke_commit_evidence_missing");
  if (evidence.branch !== branch) throw new Error("smoke_commit_branch_mismatch");
  if (evidence.repo !== basename(workspacePath)) throw new Error("smoke_commit_repo_mismatch");
  if (typeof evidence.hash !== "string" || evidence.hash.length === 0) {
    throw new Error("smoke_commit_hash_missing");
  }
}
