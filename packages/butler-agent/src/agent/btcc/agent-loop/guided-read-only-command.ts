import { readFileSync } from "node:fs";
import { budgetToolOutput } from "../../context/tool-output-budgeter.ts";
import { executeGuidedCommand } from "./guided-command/execute-command.ts";
import {
  commandEvidenceCapabilityReceipts,
  commandEvidenceReceipts,
} from "../../tools/run-command/run_command/evidence.ts";
import {
  guidedCommandArtifacts,
  type GuidedCommandArtifactSnapshot,
} from "./guided-command-artifacts.ts";

export type GuidedSpooledCommandResult = {
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
    const remoteObservation = stateEffect === "remote_observation";
    return commandBoundaryError(
      remoteObservation
        ? "command_remote_observation_requires_typed_effect"
        : "command_mutation_requires_typed_effect",
      remoteObservation
        ? "Remote observation requires full access, an accepted Plan Review, and the audited persistent-effect boundary."
        : "R3 run_command accepts only a read-only observation or validation. Use a typed persistent-effect tool for writes, Project Ledger changes, Git changes, remote calls, or deployment.",
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
    }) as GuidedSpooledCommandResult;
    return guidedCommandPublicResult({
      spooled,
      butlerData: input.butlerData,
      args: input.args,
      sandbox: "read_only_no_network",
    });
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

type GuidedCommandPublicResultInput = {
  spooled: GuidedSpooledCommandResult;
  butlerData: string;
  args: Record<string, unknown>;
} & (
  | { sandbox: "read_only_no_network" }
  | {
      sandbox: "full_access_contained";
      startedAtMs: number;
      artifactSnapshot: GuidedCommandArtifactSnapshot;
    }
);

export function guidedCommandPublicResult(
  input: GuidedCommandPublicResultInput,
): Record<string, unknown> {
  const streams = readSpooledStreams(input.spooled.payloadSource.path);
  const budgeted = budgetToolOutput({
    result: {
      stdout: streams.stdout,
      stderr: streams.stderr,
      exit_code: input.spooled.summary.exitCode,
      timed_out: input.spooled.summary.timedOut,
    },
    butlerData: input.butlerData,
    command: input.spooled.summary.command,
    cwd: input.spooled.summary.cwd,
    maxModelTokens: boundedInteger(input.args.max_output_tokens, 1_200, 200, 8_000),
  });
  const success = budgeted.exit_code === 0 && !budgeted.timed_out;
  const artifacts = input.sandbox === "full_access_contained" && success
    ? guidedCommandArtifacts({
        outputPaths: input.args.output_paths,
        butlerData: input.butlerData,
        startedAtMs: input.startedAtMs,
        before: input.artifactSnapshot,
      })
    : [];
  return {
    ok: success,
    command: input.spooled.summary.command,
    cwd: input.spooled.summary.cwd,
    exit_code: budgeted.exit_code,
    timed_out: budgeted.timed_out,
    stdout: budgeted.stdout,
    stderr: budgeted.stderr,
    sandbox: input.sandbox,
    ...(budgeted.butler_tool_artifact
      ? { butler_tool_artifact: budgeted.butler_tool_artifact }
      : {}),
    ...(artifacts.length > 0
      ? {
          artifacts,
          verified_output_files: artifacts,
          evidence_receipts: commandEvidenceReceipts({ success, artifacts }),
          evidence_capability_receipts: commandEvidenceCapabilityReceipts({
            exitCode: budgeted.exit_code,
            timedOut: budgeted.timed_out,
            outputSuppressed: false,
            outputBudgeted: Boolean(budgeted.butler_tool_artifact),
            artifacts,
          }),
        }
      : {}),
  };
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
