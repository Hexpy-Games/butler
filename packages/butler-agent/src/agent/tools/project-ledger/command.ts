import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export function commandForProjectLedgerNativeTool(
  toolName: string,
  args: Record<string, unknown>,
  projectPath: string,
): string[] {
  const project = ["--project", projectPath];
  if (toolName === "project_ledger_index") return ["index", ...project];
  if (toolName === "project_ledger_status") return ["status", ...project];
  if (toolName === "project_ledger_list") return ["query", ...project, "--kind", requireString(args, "kind")];
  if (toolName === "project_ledger_show") return ["record", "show", ...project, ...recordIdentityArgs(args), ...booleanFlag(args, "include_body", "body")];
  if (toolName === "project_ledger_create") return createArgs(args, project);
  if (toolName === "project_ledger_update") return withBodyFile(args, ["record", "update", ...project, ...recordIdentityArgs(args), ...metadataArgs(args)]);
  if (toolName === "project_ledger_work_update") return withBodyFile(args, ["work", "update", ...project, "--id", requireString(args, "id"), ...metadataArgs(args)]);
  if (toolName === "project_ledger_work_complete") return withBodyFile(args, ["work", "complete", ...project, "--id", requireString(args, "id"), ...metadataArgs(args)]);
  if (toolName === "project_ledger_task_update") return withBodyFile(args, ["task", "update", ...project, "--id", requireString(args, "id"), ...metadataArgs(args)]);
  if (toolName === "project_ledger_task_complete") return withBodyFile(args, ["task", "complete", ...project, "--id", requireString(args, "id"), ...metadataArgs(args)]);
  if (toolName === "project_ledger_attempt_start") return withBodyFile(args, ["attempt", "start", ...project, "--task", requireString(args, "task_id"), ...optionalIdArgs(args), ...metadataArgs(args)]);
  if (toolName === "project_ledger_attempt_succeed") return withBodyFile(args, ["attempt", "succeed", ...project, "--id", requireString(args, "id"), ...metadataArgs(args)]);
  if (toolName === "project_ledger_attempt_fail") return withBodyFile(args, ["attempt", "fail", ...project, "--id", requireString(args, "id"), ...metadataArgs(args)]);
  if (toolName === "project_ledger_render") return ["render", ...project, requireString(args, "view"), ...booleanFlag(args, "write", "write")];
  if (toolName === "project_ledger_check") return ["check", ...project, ...booleanFlag(args, "verbose", "verbose")];
  throw new Error(`Unknown Project Ledger tool: ${toolName}`);
}

function createArgs(args: Record<string, unknown>, project: string[]): string[] {
  const kind = requireString(args, "kind");
  if (kind === "work") return withBodyFile(args, ["work", "create", ...project, "--id", requireString(args, "id"), "--title", requireString(args, "title"), ...metadataArgs(args)]);
  if (kind === "task") return withBodyFile(args, ["task", "create", ...project, "--work", requireString(args, "work_id"), "--id", requireString(args, "id"), "--title", requireString(args, "title"), ...metadataArgs(args)]);
  if (kind === "attempt") return withBodyFile(args, ["attempt", "start", ...project, "--task", requireString(args, "task_id"), "--id", requireString(args, "id"), "--title", requireString(args, "title"), ...metadataArgs(args)]);
  return withBodyFile(args, ["record", "create", ...project, "--kind", kind, "--id", requireString(args, "id"), "--title", requireString(args, "title"), ...metadataArgs(args)]);
}

function withBodyFile(args: Record<string, unknown>, cliArgs: string[]): string[] {
  const body = stringArg(args, "body");
  if (!body) return cliArgs;
  const dir = mkdtempSync(join(tmpdir(), "butler-project-ledger-tool-"));
  const path = join(dir, "body.md");
  writeFileSync(path, body, "utf8");
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return [...cliArgs, "--from", path];
}

function recordIdentityArgs(args: Record<string, unknown>): string[] {
  return ["--id", requireString(args, "id"), ...stringFlag(args, "kind", "kind")];
}

function optionalIdArgs(args: Record<string, unknown>): string[] {
  return stringFlag(args, "id", "id");
}

function metadataArgs(args: Record<string, unknown>): string[] {
  return [
    ...stringFlag(args, "title", "title"),
    ...stringFlag(args, "status", "status"),
    ...stringFlag(args, "spec", "spec"),
    ...stringFlag(args, "validation", "validation"),
    ...stringFlag(args, "review", "review"),
    ...stringFlag(args, "report", "report"),
    ...stringFlag(args, "code_commits", "code-commits"),
    ...stringFlag(args, "code_commit", "code-commit"),
    ...stringFlag(args, "ledger_commits", "ledger-commits"),
    ...stringFlag(args, "acceptance", "acceptance"),
    ...stringFlag(args, "implementation", "implementation"),
    ...stringFlag(args, "mitigation", "mitigation"),
    ...booleanFlag(args, "requires_commit_evidence", "requires-commit-evidence"),
    ...numberFlag(args, "priority", "priority"),
  ];
}

function stringFlag(args: Record<string, unknown>, key: string, flag: string): string[] {
  const value = stringArg(args, key);
  return value ? [`--${flag}`, value] : [];
}

function numberFlag(args: Record<string, unknown>, key: string, flag: string): string[] {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? [`--${flag}`, String(value)] : [];
}

function booleanFlag(args: Record<string, unknown>, key: string, flag: string): string[] {
  return args[key] === true ? [`--${flag}`] : [];
}

function requireString(args: Record<string, unknown>, key: string): string {
  return stringArg(args, key);
}

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? args[key].trim() : "";
}
