import { runProjectLedgerTool } from "../../../integrations/project-ledger/client.ts";
import { projectLedgerNativeNextHints } from "./recovery-hints.ts";

type ProjectLedgerExecutorInput = {
  butlerHome: string;
  butlerData: string;
  sessionId?: string;
  projectId?: string;
};

export function runProjectLedgerPlannedLifecycleMutation(input: {
  executor: ProjectLedgerExecutorInput;
  toolName: string;
  args: Record<string, unknown>;
  projectPath: string;
  finalCliArgs: string[];
}): Record<string, unknown> | null {
  if (input.toolName === "project_ledger_task_complete") {
    return runPlannedTaskComplete(input.executor, input.args, input.projectPath, input.finalCliArgs);
  }
  if (input.toolName === "project_ledger_work_complete") {
    return runPlannedWorkComplete(input.executor, input.args, input.projectPath, input.finalCliArgs);
  }
  return null;
}

function runPlannedTaskComplete(
  input: ProjectLedgerExecutorInput,
  args: Record<string, unknown>,
  projectPath: string,
  finalCliArgs: string[],
): Record<string, unknown> {
  const id = requireString(args, "id");
  const project = ["--project", projectPath];
  const current = showProjectLedgerRecord(input, projectPath, "task", id);
  if (current.ok !== true) return current;
  const status = recordStatus(current);
  const executed: string[][] = [];
  if (status === "todo") {
    const transition = runProjectLedgerTool(input, ["task", "update", ...project, "--id", id, "--status", "in_progress"]);
    executed.push(["task", "update", "--id", id, "--status", "in_progress"]);
    if (transition.ok !== true) return withRecoverableProjectLedgerError(withTransitionPlan(transition, executed));
  }
  const result = withRecoverableProjectLedgerError(runProjectLedgerTool(input, finalCliArgs));
  return withTransitionPlan(result, [...executed, lifecycleCommandSummary(finalCliArgs)]);
}

function runPlannedWorkComplete(
  input: ProjectLedgerExecutorInput,
  args: Record<string, unknown>,
  projectPath: string,
  finalCliArgs: string[],
): Record<string, unknown> {
  const id = requireString(args, "id");
  const project = ["--project", projectPath];
  const current = showProjectLedgerRecord(input, projectPath, "work", id);
  if (current.ok !== true) return current;
  const missing = missingWorkCompletionEvidence(current, args);
  if (missing.length > 0) return workCompletionGateFailure(id, missing);
  const status = recordStatus(current);
  const plannedStatuses = plannedWorkStatuses(status);
  const executed: string[][] = [];
  for (const nextStatus of plannedStatuses) {
    const transition = runProjectLedgerTool(input, ["work", "update", ...project, "--id", id, "--status", nextStatus]);
    executed.push(["work", "update", "--id", id, "--status", nextStatus]);
    if (transition.ok !== true) return withRecoverableProjectLedgerError(withTransitionPlan(transition, executed));
  }
  const result = withRecoverableProjectLedgerError(runProjectLedgerTool(input, finalCliArgs));
  return withTransitionPlan(result, [...executed, lifecycleCommandSummary(finalCliArgs)]);
}

function showProjectLedgerRecord(
  input: ProjectLedgerExecutorInput,
  projectPath: string,
  kind: "task" | "work",
  id: string,
): Record<string, unknown> {
  return withRecoverableProjectLedgerError(runProjectLedgerTool(input, [
    "record",
    "show",
    "--project",
    projectPath,
    "--kind",
    kind,
    "--id",
    id,
  ]));
}

function recordStatus(result: Record<string, unknown>): string {
  const data = result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : {};
  return typeof data.status === "string" ? data.status : "";
}

function missingWorkCompletionEvidence(
  current: Record<string, unknown>,
  args: Record<string, unknown>,
): string[] {
  const data = current.data && typeof current.data === "object" && !Array.isArray(current.data)
    ? current.data as Record<string, unknown>
    : {};
  const missing: string[] = [];
  if (!stringValue(args.spec) && !stringValue(data.spec) && data.specExemption !== true) missing.push("spec");
  if (!stringValue(args.acceptance) && !stringValue(data.acceptance) && data.acceptanceExemption !== true) {
    missing.push("acceptance");
  }
  for (const field of ["validation", "review", "report"] as const) {
    if (!stringValue(args[field]) && !stringValue(data[field])) missing.push(field);
  }
  if (
    data.requiresCommitEvidence === true &&
    stringValue(args.code_commit) !== "auto" &&
    !hasCodeCommitEvidence(args.code_commits) &&
    !hasCodeCommitEvidence(data.codeCommits)
  ) {
    missing.push("codeCommits");
  }
  return missing;
}

function workCompletionGateFailure(id: string, missing: readonly string[]): Record<string, unknown> {
  return {
    ok: false,
    recoverable: true,
    error: {
      code: "completion_gate_failed",
      message: `Work completion gate failed: ${missing.join(", ")}`,
      details: missing.map((field) => ({
        code: `missing_${field}`,
        field,
        message: `Completed work is missing ${field} evidence`,
      })),
      native_next: [{
        tool: "project_ledger_work_complete",
        args: { id },
        reason: "Provide missing completion evidence before completing the work.",
      }],
    },
  };
}

function plannedWorkStatuses(status: string): string[] {
  if (status === "proposed") return ["scoped", "in_progress", "review"];
  if (status === "scoped" || status === "blocked") return ["in_progress", "review"];
  if (status === "specified") return ["in_progress", "review"];
  if (status === "in_progress") return ["review"];
  return [];
}

function withTransitionPlan(result: Record<string, unknown>, commands: readonly string[][]): Record<string, unknown> {
  return {
    ...result,
    project_ledger_transition_plan: {
      executed: commands.map((command) => ({ command: command.join(" ") })),
    },
  };
}

function lifecycleCommandSummary(cliArgs: readonly string[]): string[] {
  const summary: string[] = [];
  for (let index = 0; index < cliArgs.length; index += 1) {
    if (cliArgs[index] === "--project") {
      index += 1;
      continue;
    }
    summary.push(cliArgs[index]!);
  }
  return summary;
}

function withRecoverableProjectLedgerError(result: Record<string, unknown>): Record<string, unknown> {
  if (result.ok !== false || !result.error || typeof result.error !== "object" || Array.isArray(result.error)) return result;
  const error = result.error as Record<string, unknown>;
  const nativeNext = projectLedgerNativeNextHints(error);
  if (nativeNext.length === 0) return result;
  return {
    ...result,
    recoverable: true,
    error: {
      ...error,
      native_next: nativeNext,
    },
  };
}

function requireString(args: Record<string, unknown>, key: string): string {
  return stringValue(args[key]);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasCodeCommitEvidence(value: unknown): boolean {
  const text = stringValue(value);
  if (!text) return false;
  try {
    const commits = JSON.parse(text) as unknown;
    return Array.isArray(commits) && commits.some((commit) => Boolean(
      commit &&
      typeof commit === "object" &&
      !Array.isArray(commit) &&
      stringValue((commit as Record<string, unknown>).repo) &&
      stringValue((commit as Record<string, unknown>).hash) &&
      stringValue((commit as Record<string, unknown>).message),
    ));
  } catch {
    return false;
  }
}
