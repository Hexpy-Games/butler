import { runProjectLedgerTool } from "../../../integrations/project-ledger/client.ts";
import { projectLedgerNativeNextHints } from "./recovery-hints.ts";

type ProjectLedgerExecutorInput = {
  butlerHome: string;
  butlerData: string;
  sessionId?: string;
  projectId?: string;
};
type ProjectLedgerToolRunner = typeof runProjectLedgerTool;

const MAX_REPLAN_REFRESHES = 1;

export function runProjectLedgerPlannedLifecycleMutation(input: {
  executor: ProjectLedgerExecutorInput;
  toolName: string;
  args: Record<string, unknown>;
  projectPath: string;
  finalCliArgs: string[];
  runTool?: ProjectLedgerToolRunner;
}): Record<string, unknown> | null {
  const runTool = input.runTool ?? runProjectLedgerTool;
  if (input.toolName === "project_ledger_task_complete") {
    return runWithBoundedReplan((refreshes) =>
      runPlannedTaskComplete(input.executor, input.args, input.projectPath, input.finalCliArgs, runTool, refreshes));
  }
  if (input.toolName === "project_ledger_work_complete") {
    return runWithBoundedReplan((refreshes) =>
      runPlannedWorkComplete(input.executor, input.args, input.projectPath, input.finalCliArgs, runTool, refreshes));
  }
  return null;
}

function runWithBoundedReplan(plan: (refreshes: number) => Record<string, unknown>): Record<string, unknown> {
  for (let refreshes = 0; refreshes <= MAX_REPLAN_REFRESHES; refreshes += 1) {
    const result = plan(refreshes);
    if (refreshes < MAX_REPLAN_REFRESHES && errorCode(result) === "invalid_transition") continue;
    return withTransitionRefreshes(result, refreshes);
  }
  return plan(MAX_REPLAN_REFRESHES);
}

function runPlannedTaskComplete(
  input: ProjectLedgerExecutorInput,
  args: Record<string, unknown>,
  projectPath: string,
  finalCliArgs: string[],
  runTool: ProjectLedgerToolRunner,
  refreshes: number,
): Record<string, unknown> {
  const id = requireString(args, "id");
  const project = ["--project", projectPath];
  const current = showProjectLedgerRecord(input, projectPath, "task", id, runTool);
  if (current.ok !== true) return current;
  const status = recordStatus(current);
  if (status === "done") return completedRecordResult("project_ledger_task_complete", current, args, refreshes);
  const plannedStatuses = plannedTaskStatuses(status);
  const executed: string[][] = [];
  for (const nextStatus of plannedStatuses) {
    const transition = runTool(input, ["task", "update", ...project, "--id", id, "--status", nextStatus]);
    executed.push(["task", "update", "--id", id, "--status", nextStatus]);
    if (transition.ok !== true) return withRecoverableProjectLedgerError(withTransitionPlan(transition, executed, refreshes));
  }
  const result = withRecoverableProjectLedgerError(runTool(input, finalCliArgs));
  return withTransitionPlan(result, [...executed, lifecycleCommandSummary(finalCliArgs)], refreshes);
}

function runPlannedWorkComplete(
  input: ProjectLedgerExecutorInput,
  args: Record<string, unknown>,
  projectPath: string,
  finalCliArgs: string[],
  runTool: ProjectLedgerToolRunner,
  refreshes: number,
): Record<string, unknown> {
  const id = requireString(args, "id");
  const project = ["--project", projectPath];
  const current = showProjectLedgerRecord(input, projectPath, "work", id, runTool);
  if (current.ok !== true) return current;
  const status = recordStatus(current);
  if (status === "done") return completedRecordResult("project_ledger_work_complete", current, args, refreshes);
  const missing = missingWorkCompletionEvidence(current, args);
  if (missing.length > 0) return workCompletionGateFailure(id, missing);
  const plannedStatuses = plannedWorkStatuses(status);
  const executed: string[][] = [];
  for (const nextStatus of plannedStatuses) {
    const transition = runTool(input, ["work", "update", ...project, "--id", id, "--status", nextStatus]);
    executed.push(["work", "update", "--id", id, "--status", nextStatus]);
    if (transition.ok !== true) return withRecoverableProjectLedgerError(withTransitionPlan(transition, executed, refreshes));
  }
  const result = withRecoverableProjectLedgerError(runTool(input, finalCliArgs));
  return withTransitionPlan(result, [...executed, lifecycleCommandSummary(finalCliArgs)], refreshes);
}

function showProjectLedgerRecord(
  input: ProjectLedgerExecutorInput,
  projectPath: string,
  kind: "task" | "work",
  id: string,
  runTool: ProjectLedgerToolRunner,
): Record<string, unknown> {
  return withRecoverableProjectLedgerError(runTool(input, [
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

function plannedTaskStatuses(status: string): string[] {
  if (status === "todo" || status === "blocked" || status === "failed") return ["in_progress"];
  return [];
}

function completedRecordResult(
  toolName: string,
  current: Record<string, unknown>,
  args: Record<string, unknown>,
  refreshes: number,
): Record<string, unknown> {
  if (suppliedMetadataMatches(current, args, toolName)) return withTransitionPlan(current, [], refreshes);
  const id = requireString(args, "id");
  return withTransitionPlan({
    ok: false,
    recoverable: true,
    error: {
      code: "already_completed",
      message: "Project Ledger record is already completed and supplied closeout evidence does not match the current record.",
      details: [{ id, tool: toolName, status: "done" }],
      native_next: [{
        tool: "project_ledger_show",
        args: { id },
        reason: "Inspect the completed record before deciding whether a metadata update is required.",
      }],
    },
  }, [], refreshes);
}

function suppliedMetadataMatches(
  current: Record<string, unknown>,
  args: Record<string, unknown>,
  toolName: string,
): boolean {
  const data = current.data && typeof current.data === "object" && !Array.isArray(current.data)
    ? current.data as Record<string, unknown>
    : {};
  for (const field of ["validation", "review", "report"] as const) {
    if (!stringValue(args[field]) || stringValue(args[field]) !== stringValue(data[field])) return false;
  }
  if (
    toolName === "project_ledger_work_complete" &&
    data.requiresCommitEvidence === true &&
    (!stringValue(args.code_commits) || stringValue(args.code_commits) !== stringValue(data.codeCommits))
  ) {
    return false;
  }
  const fields = [
    ["code_commits", "codeCommits"],
    ["ledger_commits", "ledgerCommits"],
  ] as const;
  if (stringValue(args.body) || stringValue(args.code_commit)) return false;
  return fields.every(([argKey, dataKey]) => !stringValue(args[argKey]) || stringValue(args[argKey]) === stringValue(data[dataKey]));
}

function withTransitionPlan(
  result: Record<string, unknown>,
  commands: readonly string[][],
  refreshes: number,
): Record<string, unknown> {
  return {
    ...result,
    project_ledger_transition_plan: {
      executed: commands.map((command) => ({ command: command.join(" ") })),
      refreshes,
    },
  };
}

function withTransitionRefreshes(result: Record<string, unknown>, refreshes: number): Record<string, unknown> {
  const plan = result.project_ledger_transition_plan &&
    typeof result.project_ledger_transition_plan === "object" &&
    !Array.isArray(result.project_ledger_transition_plan)
    ? result.project_ledger_transition_plan as Record<string, unknown>
    : {};
  return {
    ...result,
    project_ledger_transition_plan: {
      ...plan,
      refreshes,
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

function errorCode(result: Record<string, unknown>): string {
  const error = result.error && typeof result.error === "object" && !Array.isArray(result.error)
    ? result.error as Record<string, unknown>
    : {};
  return stringValue(error.code);
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
