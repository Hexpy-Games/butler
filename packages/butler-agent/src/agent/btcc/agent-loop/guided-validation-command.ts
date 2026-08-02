import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { budgetToolOutput } from "../../context/tool-output-budgeter.ts";
import {
  commandEvidenceCapabilityReceipts,
  commandEvidenceReceipts,
} from "../../tools/run-command/run_command/evidence.ts";
import { executeGuidedCommand } from "./guided-command/execute-command.ts";
import { publishGuidedValidationArtifacts } from
  "./guided-validation-artifact-publication.ts";

type SpooledCommandResult = Awaited<ReturnType<typeof executeGuidedCommand>>;

export async function executeGuidedValidationCommand(input: {
  args: Record<string, unknown>;
  butlerData: string;
  workspacePath: string;
  originalRequest: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const suite = nonEmptyString(input.args.validation_suite);
  if (!suite) {
    return validationBoundaryError(
      "validation_suite_required",
      "Writable validation requires a stable validation_suite.",
    );
  }
  if (process.platform !== "darwin") {
    return validationBoundaryError(
      "command_validation_isolation_unavailable",
      "This host cannot enforce Butler's isolated, no-network validation boundary.",
    );
  }
  const runtimeRoot = join(input.butlerData, "runtime");
  const artifactBase = join(input.butlerData, "artifacts", "generated");
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(artifactBase, { recursive: true });
  const validationRoot = mkdtempSync(join(runtimeRoot, "guided-validation-"));
  const workspaceCopy = join(validationRoot, "workspace");
  const homeRoot = join(validationRoot, "home");
  const tempRoot = join(validationRoot, "tmp");
  const artifactStagingRoot = join(validationRoot, "artifacts");
  mkdirSync(homeRoot, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });
  mkdirSync(artifactStagingRoot, { recursive: true });
  const startedAtMs = Date.now();
  try {
    cloneWorkspace(input.workspacePath, workspaceCopy);
    const spooled = await executeGuidedCommand(
      validationCommandArgs(input.args, input.workspacePath),
      {
        butlerData: input.butlerData,
        workspacePath: workspaceCopy,
        originalRequest: input.originalRequest,
        accessMode: "read_only",
        filesystemBoundary: {
          kind: "isolated_validation",
          writeRoots: [validationRoot],
          homeRoot,
          tempRoot,
          artifactRoot: artifactStagingRoot,
        },
        signal: input.signal,
      },
    );
    return validationResult({
      args: input.args,
      artifactBase,
      artifactRoot: artifactStagingRoot,
      originalWorkspace: input.workspacePath,
      spooled,
      startedAtMs,
      suite,
    });
  } catch (error) {
    return validationBoundaryError(
      errorCode(error),
      error instanceof Error ? error.message : "The isolated validation failed.",
    );
  } finally {
    rmSync(validationRoot, { recursive: true, force: true });
  }
}

function validationCommandArgs(
  args: Record<string, unknown>,
  originalWorkspace: string,
): Record<string, unknown> {
  if (typeof args.cwd !== "string" || !isAbsolute(args.cwd)) return args;
  const workspace = resolve(originalWorkspace);
  const requested = resolve(args.cwd);
  const contained = relative(workspace, requested);
  if (contained.startsWith("..") || isAbsolute(contained)) return args;
  return { ...args, cwd: contained || "." };
}

function cloneWorkspace(source: string, destination: string): void {
  const sourceRoot = resolve(source);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const from = join(sourceRoot, entry.name);
    const to = join(destination, entry.name);
    cloneWorkspaceEntry(from, to, entry.name);
  }
}

function cloneWorkspaceEntry(
  source: string,
  destination: string,
  name: string,
): void {
  const stat = lstatSync(source);
  if (stat.isDirectory() && (name === "node_modules" || name === ".git")) {
    symlinkSync(source, destination, "dir");
    return;
  }
  cloneEntry(source, destination);
}

function cloneEntry(source: string, destination: string): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: stat.mode });
    for (const entry of readdirSync(source)) {
      cloneWorkspaceEntry(
        join(source, entry),
        join(destination, entry),
        entry,
      );
    }
    return;
  }
  if (!stat.isFile()) return;
  copyFileSync(source, destination, constants.COPYFILE_FICLONE);
  chmodSync(destination, stat.mode);
}

function validationResult(input: {
  args: Record<string, unknown>;
  artifactBase: string;
  artifactRoot: string;
  originalWorkspace: string;
  spooled: SpooledCommandResult;
  startedAtMs: number;
  suite: string;
}): Record<string, unknown> {
  const streams = readSpooledStreams(input.spooled.payloadSource.path);
  const success = input.spooled.summary.exitCode === 0 && !input.spooled.summary.timedOut;
  const outputMode = typeof input.args.output_mode === "string"
    ? input.args.output_mode
    : "auto";
  const suppress = success && outputMode !== "full";
  const budgeted = budgetToolOutput({
    result: {
      stdout: suppress ? "" : streams.stdout,
      stderr: suppress ? "" : streams.stderr,
      exit_code: input.spooled.summary.exitCode,
      timed_out: input.spooled.summary.timedOut,
    },
    butlerData: resolve(input.artifactBase, "..", ".."),
    command: input.spooled.summary.command,
    cwd: input.originalWorkspace,
    maxModelTokens: boundedInteger(input.args.max_output_tokens, 1_200, 200, 8_000),
  });
  const artifacts = publishGuidedValidationArtifacts({
    artifactBase: input.artifactBase,
    artifactRoot: input.artifactRoot,
    outputPaths: input.args.output_paths,
    startedAtMs: input.startedAtMs,
  });
  return {
    ok: success,
    command: input.spooled.summary.command,
    cwd: input.originalWorkspace,
    exit_code: budgeted.exit_code,
    timed_out: budgeted.timed_out,
    stdout: budgeted.stdout,
    stderr: budgeted.stderr,
    sandbox: "isolated_validation_no_network",
    ...(budgeted.butler_tool_artifact
      ? { butler_tool_artifact: budgeted.butler_tool_artifact }
      : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    evidence_receipts: commandEvidenceReceipts({ success, artifacts }),
    evidence_capability_receipts: commandEvidenceCapabilityReceipts({
      exitCode: input.spooled.summary.exitCode,
      timedOut: input.spooled.summary.timedOut,
      outputSuppressed: suppress,
      outputBudgeted: Boolean(budgeted.butler_tool_artifact),
      artifacts,
      validations: [{
        suite: input.suite,
        result: success ? "passed" : "failed",
        ...(success ? {} : { failure_summary: "Isolated validation did not pass." }),
      }],
    }),
  };
}

function readSpooledStreams(path: string): { stdout: string; stderr: string } {
  const payload = readFileSync(path, "utf8");
  const stdoutMarker = "\n--- stdout ---\n";
  const stderrMarker = "\n--- stderr ---\n";
  const stdoutStart = payload.indexOf(stdoutMarker);
  const stderrStart = payload.indexOf(stderrMarker);
  if (stdoutStart < 0 || stderrStart < stdoutStart) return { stdout: "", stderr: "" };
  return {
    stdout: payload.slice(stdoutStart + stdoutMarker.length, stderrStart),
    stderr: payload.slice(stderrStart + stderrMarker.length),
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function validationBoundaryError(code: string, message: string): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable: true,
      next_action: "Use isolated validation outputs under $BUTLER_ARTIFACTS_DIR or report the limitation.",
    },
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const value = (error as { code?: unknown }).code;
    if (typeof value === "string" && value) return value;
  }
  return "isolated_validation_failed";
}
