import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { budgetToolOutput } from "../../context/tool-output-budgeter.ts";
import {
  commandEvidenceCapabilityReceipts,
  commandEvidenceReceipts,
  type CommandArtifactEvidence,
} from "../../tools/run-command/run_command/evidence.ts";
import { executeGuidedCommand } from "./guided-command/execute-command.ts";

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
    const spooled = await executeGuidedCommand(input.args, {
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
    });
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
  removeArtifactSymlinks(input.artifactRoot);
  const artifacts = publishValidationArtifacts({
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

function publishValidationArtifacts(input: {
  artifactBase: string;
  artifactRoot: string;
  outputPaths: unknown;
  startedAtMs: number;
}): CommandArtifactEvidence[] {
  const declared = Array.isArray(input.outputPaths)
    ? input.outputPaths.filter((value): value is string => typeof value === "string")
    : [];
  const candidates = declared.length > 0
    ? declared.map((value) => expandArtifactPath(value, input.artifactRoot))
    : recentArtifactFiles(input.artifactRoot, input.startedAtMs);
  const seen = new Set<string>();
  const accepted: Array<{
    path: string;
    relativePath: string;
  }> = [];
  const canonicalArtifactRoot = realpathSync.native(input.artifactRoot);
  for (const candidate of candidates.slice(0, 24)) {
    const path = resolve(candidate);
    if (!inside(input.artifactRoot, path) || seen.has(path) || !existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile()) continue;
    const real = realpathSync.native(path);
    if (!inside(canonicalArtifactRoot, real)) continue;
    seen.add(path);
    accepted.push({ path, relativePath: relative(input.artifactRoot, path) });
  }
  if (accepted.length === 0) return [];
  const publicationRoot = mkdtempSync(join(input.artifactBase, "validation-"));
  try {
    return accepted.map((candidate) => {
      const publishedPath = join(publicationRoot, candidate.relativePath);
      mkdirSync(dirname(publishedPath), { recursive: true });
      copyRegularFileNoFollow(candidate.path, publishedPath);
      const published = lstatSync(publishedPath);
      if (!published.isFile()) {
        throw new Error("Validation artifact publication produced a non-file entry");
      }
      return {
        path: join(
          "artifacts",
          "generated",
          relative(input.artifactBase, publishedPath),
        ),
        artifact_kind: artifactKind(publishedPath),
        size_bytes: published.size,
        modified_at: new Date(published.mtimeMs).toISOString(),
      } satisfies CommandArtifactEvidence;
    });
  } catch (error) {
    rmSync(publicationRoot, { recursive: true, force: true });
    throw error;
  }
}

function copyRegularFileNoFollow(source: string, destination: string): void {
  const sourceFd = openSync(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let destinationFd: number | null = null;
  try {
    const before = fstatSync(sourceFd);
    if (!before.isFile()) {
      throw new Error("Validation artifact source is not a regular file");
    }
    destinationFd = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        written += writeSync(
          destinationFd,
          buffer,
          written,
          bytesRead - written,
        );
      }
      position += bytesRead;
    }
    const after = fstatSync(sourceFd);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Validation artifact changed during publication");
    }
  } finally {
    if (destinationFd !== null) closeSync(destinationFd);
    closeSync(sourceFd);
  }
}

function removeArtifactSymlinks(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      unlinkSync(path);
    } else if (entry.isDirectory()) {
      removeArtifactSymlinks(path);
    }
  }
}

function recentArtifactFiles(root: string, startedAtMs: number): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= 1_000) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && statSync(path).mtimeMs >= startedAtMs - 100) files.push(path);
    }
  };
  visit(root);
  return files;
}

function expandArtifactPath(value: string, artifactRoot: string): string {
  const trimmed = value.trim();
  for (const token of ["$BUTLER_ARTIFACTS_DIR", "${BUTLER_ARTIFACTS_DIR}"]) {
    if (trimmed === token) return artifactRoot;
    if (trimmed.startsWith(`${token}/`)) return join(artifactRoot, trimmed.slice(token.length + 1));
  }
  return isAbsolute(trimmed) ? trimmed : join(artifactRoot, trimmed);
}

function artifactKind(path: string): CommandArtifactEvidence["artifact_kind"] {
  const extension = extname(path).toLowerCase();
  if (extension === ".csv") return "csv_file";
  if (extension === ".tsv") return "table_file";
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg", ".pdf"].includes(extension)) {
    return "chart_file";
  }
  return "file";
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

function inside(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value === "" || Boolean(value && !value.startsWith("..") && !isAbsolute(value));
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
