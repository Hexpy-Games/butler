import { readFileSync } from "node:fs";
import { budgetToolOutput } from "../../context/tool-output-budgeter.ts";
import { executeGuidedCommand } from "./guided-command/execute-command.ts";

type SpooledCommandResult = {
  summary: {
    command: string;
    cwd: string;
    exitCode: number | null;
    timedOut: boolean;
  };
  payloadSource: { path: string };
};

export async function executeGuidedReadOnlyCommand(input: {
  args: Record<string, unknown>;
  butlerData: string;
  workspacePath: string;
  originalRequest: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const stateEffect = input.args.state_effect ?? "read_only";
  if (stateEffect !== "read_only" && stateEffect !== "validation") {
    return commandBoundaryError(
      "command_mutation_requires_typed_effect",
      "R3 run_command accepts only a read-only observation or validation. Use a typed persistent-effect tool for writes, Project Ledger changes, Git changes, remote calls, or deployment.",
    );
  }
  try {
    const spooled = await executeGuidedCommand(input.args, {
      butlerData: input.butlerData,
      workspacePath: input.workspacePath,
      originalRequest: input.originalRequest,
      accessMode: "read_only",
      filesystemBoundary: { kind: "read_only_observation" },
      signal: input.signal,
    }) as SpooledCommandResult;
    const streams = readSpooledStreams(spooled.payloadSource.path);
    const budgeted = budgetToolOutput({
      result: {
        stdout: streams.stdout,
        stderr: streams.stderr,
        exit_code: spooled.summary.exitCode,
        timed_out: spooled.summary.timedOut,
      },
      butlerData: input.butlerData,
      command: spooled.summary.command,
      cwd: spooled.summary.cwd,
      maxModelTokens: boundedInteger(input.args.max_output_tokens, 1_200, 200, 8_000),
    });
    return {
      ok: budgeted.exit_code === 0 && !budgeted.timed_out,
      command: spooled.summary.command,
      cwd: spooled.summary.cwd,
      exit_code: budgeted.exit_code,
      timed_out: budgeted.timed_out,
      stdout: budgeted.stdout,
      stderr: budgeted.stderr,
      sandbox: "read_only_no_network",
      ...(budgeted.butler_tool_artifact
        ? { butler_tool_artifact: budgeted.butler_tool_artifact }
        : {}),
    };
  } catch (error) {
    const code = errorCode(error);
    return commandBoundaryError(
      code,
      code === "command_observation_isolation_unavailable"
        ? "This host cannot enforce Butler's read-only, no-network command boundary. Use native read tools or a typed effect capability."
        : error instanceof Error ? error.message : "The read-only command failed.",
    );
  }
}

function readSpooledStreams(path: string): { stdout: string; stderr: string } {
  const payload = readFileSync(path, "utf8");
  const stdoutMarker = "\n--- stdout ---\n";
  const stderrMarker = "\n--- stderr ---\n";
  const stdoutStart = payload.indexOf(stdoutMarker);
  const stderrStart = payload.indexOf(stderrMarker);
  if (stdoutStart < 0 || stderrStart < stdoutStart) {
    return { stdout: "", stderr: "Command output was not readable." };
  }
  return {
    stdout: payload.slice(stdoutStart + stdoutMarker.length, stderrStart),
    stderr: payload.slice(stderrStart + stderrMarker.length),
  };
}

function commandBoundaryError(code: string, message: string): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable: true,
      next_action: "Use native read tools, a typed persistent-effect tool, or report the concrete limitation.",
    },
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const value = (error as { code?: unknown }).code;
    if (typeof value === "string" && value) return value;
  }
  return "read_only_command_failed";
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
