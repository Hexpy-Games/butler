import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "fs";
import { extname, isAbsolute, join, relative, resolve } from "path";
import { budgetToolOutput, type ShellCommandResult } from "../../../context/tool-output-budgeter.ts";
import { butlerToolProcessEnvironment } from "../../../tool-support/executor-support.ts";
import type { CommandExecutor } from "../../../../runtime/command/contracts.ts";
import { executeLegacyCommandCompatibility } from "../../../../runtime/command/legacy-command-compat.ts";
import { createPlatformCommandExecutor } from "../../../../runtime/command/platform-command-executor.ts";
import {
  commandEvidenceCapabilityReceipts,
  commandEvidenceReceipts,
  type CommandArtifactEvidence,
  type CommandValidationEvidence,
} from "./evidence.ts";
import { projectLedgerCommandMutationGuard } from "./project-ledger-command-guard.ts";
import {
  cleanupProjectLedgerMutationSnapshot,
  createProjectLedgerMutationSnapshot,
  restoreProjectLedgerMutationIfChanged,
} from "./project-ledger-mutation-snapshot.ts";

type ToolCall = { args: Record<string, unknown>; signal?: AbortSignal };

export function createRunCommandToolHandlers(input: {
  butlerHome: string;
  butlerData: string;
  workspacePath: string;
  commandExecutor?: CommandExecutor;
}) {
  const commandExecutor = input.commandExecutor ?? createPlatformCommandExecutor();
  return {
    "run_command": async (call: ToolCall) => await runCommandTool({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      workspacePath: input.workspacePath,
      args: call.args,
      signal: call.signal,
      commandExecutor,
    }),
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 300_000;
const MAX_COMMAND_CAPTURE_CHARS = 5_000_000;
const COMMAND_GENERATED_ARTIFACT_DIR = "generated";
function commandArtifactDataRoot(butlerData: string): string {
  return join(butlerData, "artifacts");
}

function commandGeneratedArtifactRoot(butlerData: string): string {
  return join(commandArtifactDataRoot(butlerData), COMMAND_GENERATED_ARTIFACT_DIR);
}

function boundedInteger(value: unknown, input: {
  fallback: number;
  min: number;
  max: number;
}): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return input.fallback;
  return Math.max(input.min, Math.min(input.max, Math.trunc(value)));
}

function commandWorkingDirectory(input: {
  workspacePath: string;
  cwd?: unknown;
}): string {
  const workspace = resolve(input.workspacePath);
  if (typeof input.cwd !== "string" || !input.cwd.trim()) return workspace;
  const cwd = input.cwd.trim();
  const resolved = isAbsolute(cwd) ? resolve(cwd) : resolve(workspace, cwd);
  if (!isPathInsideWorkspace({ path: resolved, workspace })) {
    throw new Error("run_command cwd must stay under the active session workspace");
  }
  return resolved;
}

function realpathIfExists(path: string): string {
  if (!existsSync(path)) return path;
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function isPathInsideWorkspace(input: {
  path: string;
  workspace: string;
}): boolean {
  const workspace = realpathIfExists(resolve(input.workspace));
  const target = realpathIfExists(resolve(input.path));
  const rel = relative(workspace, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

type CommandArtifactKind = "csv_file" | "table_file" | "chart_file" | "file";

const COMMAND_ARTIFACT_SCAN_IGNORES = new Set([
  ".git",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "build",
  "node_modules",
]);

const MAX_COMMAND_ARTIFACT_SCAN_FILES = 20_000;
const MAX_COMMAND_ARTIFACT_EVIDENCE = 24;

type GitWorkspaceStatusSnapshot = Map<string, string>;

function artifactKindForPath(path: string): CommandArtifactKind {
  const ext = extname(path).toLocaleLowerCase("en-US");
  if (ext === ".csv") return "csv_file";
  if (ext === ".tsv") return "table_file";
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg", ".pdf"].includes(ext)) return "chart_file";
  return "file";
}

function safeCommandArtifactLabel(input: {
  path: string;
  cwd: string;
  butlerData: string;
}): string {
  const artifactRoot = resolve(commandArtifactDataRoot(input.butlerData));
  const artifactRelativePath = relative(artifactRoot, input.path);
  if (artifactRelativePath && !artifactRelativePath.startsWith("..") && !isAbsolute(artifactRelativePath)) {
    return join("artifacts", artifactRelativePath);
  }
  const relativePath = relative(input.cwd, input.path);
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) return relativePath;
  return relative(resolve(input.cwd), input.path) || "command-output";
}

function verifiedCommandArtifact(input: {
  path: string;
  cwd: string;
  workspace: string;
  butlerData: string;
  allowWorkspace: boolean;
}): CommandArtifactEvidence | null {
  const resolved = resolve(input.cwd, input.path);
  const artifactRoot = commandArtifactDataRoot(input.butlerData);
  const isAllowedWorkspaceFile = input.allowWorkspace &&
    isPathInsideWorkspace({ path: resolved, workspace: input.workspace });
  const isAllowedDataArtifact = isPathInsideWorkspace({ path: resolved, workspace: artifactRoot });
  if (!isAllowedWorkspaceFile && !isAllowedDataArtifact) return null;
  if (!existsSync(resolved)) return null;
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return {
    path: safeCommandArtifactLabel({
      path: resolved,
      cwd: input.cwd,
      butlerData: input.butlerData,
    }),
    artifact_kind: artifactKindForPath(resolved),
    size_bytes: stat.size,
    modified_at: new Date(stat.mtimeMs).toISOString(),
  };
}

function expandCommandArtifactEnvPath(path: string, butlerData: string): string {
  const replacements: Array<[string, string]> = [
    ["${BUTLER_ARTIFACTS_DIR}", commandGeneratedArtifactRoot(butlerData)],
    ["$BUTLER_ARTIFACTS_DIR", commandGeneratedArtifactRoot(butlerData)],
    ["${BUTLER_ARTIFACT_DIR}", commandGeneratedArtifactRoot(butlerData)],
    ["$BUTLER_ARTIFACT_DIR", commandGeneratedArtifactRoot(butlerData)],
    ["${BUTLER_DATA}", butlerData],
    ["$BUTLER_DATA", butlerData],
  ];
  for (const [token, value] of replacements) {
    if (path === token) return value;
    if (path.startsWith(`${token}/`)) return join(value, path.slice(token.length + 1));
  }
  return path;
}

function commandArtifactPathCandidates(path: string, cwd: string, butlerData: string): string[] {
  const expanded = expandCommandArtifactEnvPath(path.trim(), butlerData);
  if (!expanded) return [];
  if (isAbsolute(expanded)) return [resolve(expanded)];
  return Array.from(new Set([
    resolve(cwd, expanded),
    resolve(butlerData, expanded),
    resolve(commandGeneratedArtifactRoot(butlerData), expanded),
  ]));
}

function uniqueCommandArtifacts(artifacts: CommandArtifactEvidence[]): CommandArtifactEvidence[] {
  const seen = new Set<string>();
  const unique: CommandArtifactEvidence[] = [];
  for (const artifact of artifacts) {
    if (seen.has(artifact.path)) continue;
    seen.add(artifact.path);
    unique.push(artifact);
  }
  return unique;
}

function commandArtifactsFromPaths(input: {
  paths: string[];
  cwd: string;
  workspace: string;
  butlerData: string;
  allowWorkspace: boolean;
}): CommandArtifactEvidence[] {
  return uniqueCommandArtifacts(input.paths
    .slice(0, MAX_COMMAND_ARTIFACT_EVIDENCE)
    .map((path) => {
      for (const candidate of commandArtifactPathCandidates(path, input.cwd, input.butlerData)) {
        const artifact = verifiedCommandArtifact({
          path: candidate,
          cwd: input.cwd,
          workspace: input.workspace,
          butlerData: input.butlerData,
          allowWorkspace: input.allowWorkspace,
        });
        if (artifact) return artifact;
      }
      return null;
    })
    .filter((artifact): artifact is CommandArtifactEvidence => Boolean(artifact)));
}

async function gitWorkspaceStatusSnapshot(
  workspace: string,
  executor: CommandExecutor,
): Promise<GitWorkspaceStatusSnapshot | null> {
  const result = await executor.execute({
    plan: {
      steps: [{
        executable: "git",
        arguments: [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ],
      }],
    },
    cwd: workspace,
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.error) {
    return null;
  }
  const snapshot: GitWorkspaceStatusSnapshot = new Map();
  const records = result.stdout.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!path || path.startsWith(".git/")) continue;
    snapshot.set(path, status);
    if ((status[0] === "R" || status[0] === "C") && index + 1 < records.length) {
      index += 1;
    }
  }
  return snapshot;
}

async function gitWorkspaceDeltaArtifacts(input: {
  before: GitWorkspaceStatusSnapshot | null;
  workspace: string;
  butlerData: string;
  success: boolean;
  executor: CommandExecutor;
}): Promise<CommandArtifactEvidence[]> {
  if (!input.success || !input.before) return [];
  const after = await gitWorkspaceStatusSnapshot(input.workspace, input.executor);
  if (!after) return [];
  const paths = [...after.entries()]
    .filter(([path, status]) => input.before?.get(path) !== status)
    .map(([path]) => path);
  return commandArtifactsFromPaths({
    paths,
    cwd: input.workspace,
    workspace: input.workspace,
    butlerData: input.butlerData,
    allowWorkspace: true,
  });
}

function declaredCommandArtifacts(
  args: Record<string, unknown>,
  cwd: string,
  workspace: string,
  butlerData: string,
): CommandArtifactEvidence[] {
  return commandArtifactsFromPaths({
    paths: stringArray(args.output_paths),
    cwd,
    workspace,
    butlerData,
    allowWorkspace: true,
  });
}

const STDOUT_ARTIFACT_PATH_KEYS = new Set([
  "artifact_file",
  "artifact_path",
  "file_path",
  "output_path",
  "report_path",
  "written_file",
]);

const STDOUT_ARTIFACT_PATH_ARRAY_KEYS = new Set([
  "artifact_files",
  "artifact_paths",
  "file_paths",
  "output_paths",
  "report_paths",
  "verified_output_files",
  "written_files",
]);

function jsonValuesFromCommandStdout(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const values: unknown[] = [];
  const parse = (text: string) => {
    try {
      values.push(JSON.parse(text));
    } catch {
      // Ignore non-JSON command output; artifact paths must be structured.
    }
  };
  parse(trimmed);
  for (const line of trimmed.split(/\r?\n/u)) {
    const candidate = line.trim();
    if (!candidate || candidate === trimmed) continue;
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    parse(candidate);
  }
  return values;
}

function collectStructuredArtifactPaths(value: unknown, output: Set<string>): void {
  if (output.size >= MAX_COMMAND_ARTIFACT_EVIDENCE) return;
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredArtifactPaths(item, output);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (output.size >= MAX_COMMAND_ARTIFACT_EVIDENCE) return;
    if (STDOUT_ARTIFACT_PATH_KEYS.has(key) && typeof item === "string" && item.trim()) {
      output.add(item.trim());
      continue;
    }
    if (STDOUT_ARTIFACT_PATH_ARRAY_KEYS.has(key)) {
      for (const path of stringArray(item)) {
        output.add(path);
        if (output.size >= MAX_COMMAND_ARTIFACT_EVIDENCE) return;
      }
      if (Array.isArray(item)) {
        for (const child of item) {
          if (child && typeof child === "object" && !Array.isArray(child)) {
            const childPath = (child as Record<string, unknown>).path;
            if (typeof childPath === "string" && childPath.trim()) output.add(childPath.trim());
          }
          if (output.size >= MAX_COMMAND_ARTIFACT_EVIDENCE) return;
        }
      }
    }
  }
}

function structuredStdoutCommandArtifacts(input: {
  stdout: string;
  cwd: string;
  workspace: string;
  butlerData: string;
}): CommandArtifactEvidence[] {
  const paths = new Set<string>();
  for (const value of jsonValuesFromCommandStdout(input.stdout)) {
    collectStructuredArtifactPaths(value, paths);
  }
  return commandArtifactsFromPaths({
    paths: [...paths],
    cwd: input.cwd,
    workspace: input.workspace,
    butlerData: input.butlerData,
    allowWorkspace: false,
  });
}

function structuredStdoutValidationEvidence(stdout: string): CommandValidationEvidence[] {
  const validations: CommandValidationEvidence[] = [];
  for (const value of jsonValuesFromCommandStdout(stdout)) {
    collectStructuredValidationEvidence(value, validations);
  }
  return validations.slice(0, 8);
}

function collectStructuredValidationEvidence(
  value: unknown,
  validations: CommandValidationEvidence[],
): void {
  if (validations.length >= 8 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredValidationEvidence(item, validations);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const candidate of [record.validation_result, record.validation]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const validation = parseStructuredValidation(candidate as Record<string, unknown>);
      if (validation) validations.push(validation);
    }
    if (validations.length >= 8) return;
  }
  if (Array.isArray(record.validation_results)) {
    for (const item of record.validation_results) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const validation = parseStructuredValidation(item as Record<string, unknown>);
        if (validation) validations.push(validation);
      }
      if (validations.length >= 8) return;
    }
  }
}

function parseStructuredValidation(record: Record<string, unknown>): CommandValidationEvidence | null {
  const suite = typeof record.suite === "string"
    ? record.suite.replace(/\s+/gu, " ").trim().slice(0, 120)
    : "";
  const result = validationResult(record.result);
  if (!suite || !result) return null;
  const failureSummary = typeof record.failure_summary === "string"
    ? record.failure_summary.replace(/\s+/gu, " ").trim().slice(0, 180)
    : typeof record.failureSummary === "string"
      ? record.failureSummary.replace(/\s+/gu, " ").trim().slice(0, 180)
      : undefined;
  return {
    suite,
    result,
    ...(failureSummary ? { failure_summary: failureSummary } : {}),
  };
}

function validationResult(value: unknown): CommandValidationEvidence["result"] | null {
  if (value === "passed" || value === "pass" || value === "success") return "passed";
  if (value === "failed" || value === "fail" || value === "failure") return "failed";
  if (value === "partial" || value === "incomplete") return "partial";
  if (value === "skipped" || value === "skip") return "skipped";
  return null;
}

function recentCommandArtifacts(input: {
  cwd: string;
  workspace: string;
  butlerData: string;
  startedAtMs: number;
}): CommandArtifactEvidence[] {
  const artifacts: CommandArtifactEvidence[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  const visit = (dir: string, depth: number) => {
    if (artifacts.length >= MAX_COMMAND_ARTIFACT_EVIDENCE || scanned >= MAX_COMMAND_ARTIFACT_SCAN_FILES || depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (artifacts.length >= MAX_COMMAND_ARTIFACT_EVIDENCE || scanned >= MAX_COMMAND_ARTIFACT_SCAN_FILES) return;
      if (COMMAND_ARTIFACT_SCAN_IGNORES.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      if (seen.has(fullPath)) continue;
      seen.add(fullPath);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.mtimeMs + 1_000 < input.startedAtMs) continue;
      const artifact = verifiedCommandArtifact({
        path: fullPath,
        cwd: input.cwd,
        workspace: input.workspace,
        butlerData: input.butlerData,
        allowWorkspace: false,
      });
      if (artifact) artifacts.push(artifact);
    }
  };
  visit(commandGeneratedArtifactRoot(input.butlerData), 0);
  return artifacts;
}

function commandArtifactEvidenceFields(artifacts: CommandArtifactEvidence[]): Record<string, unknown> {
  if (artifacts.length === 0) return {};
  const labels = Array.from(new Set(artifacts.map((artifact) => artifact.path)));
  const kinds = Array.from(new Set(artifacts.map((artifact) => artifact.artifact_kind)));
  const dataTableCreated = artifacts.some((artifact) =>
    artifact.artifact_kind === "csv_file" || artifact.artifact_kind === "table_file");
  const chartRendered = artifacts.some((artifact) => artifact.artifact_kind === "chart_file");
  return {
    durable_artifact_created: true,
    verified_output_files: artifacts,
    written_files: labels,
    written_file: labels[0],
    artifact_labels: labels,
    artifact_label: labels[0],
    artifact_kinds: kinds,
    artifact_kind: kinds[0],
    ...(dataTableCreated ? { data_table_created: true } : {}),
    ...(chartRendered ? { chart_rendered: true } : {}),
  };
}

async function executeCommandCompatibility(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  butlerData: string;
  pipefail: boolean;
  signal?: AbortSignal;
  commandExecutor: CommandExecutor;
}): Promise<ShellCommandResult> {
  const raw = await executeLegacyCommandCompatibility(input.commandExecutor, {
    command: input.command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    environment: butlerToolProcessEnvironment({ butlerData: input.butlerData }),
    pipefail: input.pipefail,
    signal: input.signal,
  });
  return {
    ...raw,
    stdout: boundedCommandCapture(raw.stdout, "stdout"),
    stderr: boundedCommandCapture(raw.stderr, "stderr"),
  };
}

function boundedCommandCapture(value: string, stream: "stdout" | "stderr"): string {
  if (value.length <= MAX_COMMAND_CAPTURE_CHARS) return value;
  return `${value.slice(0, MAX_COMMAND_CAPTURE_CHARS)}\n[${stream} truncated after ${MAX_COMMAND_CAPTURE_CHARS} chars]`;
}

function throwIfCommandAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Runtime turn was cancelled.");
}

function sliceLastCharacters(value: string, maxChars: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return chars.slice(-maxChars).join("");
}

function boundOutputOnFailure(output: string, maxLines: number = 20, maxChars: number = 1000): string {
  if (!output) return output;
  const lines = output.split("\n");
  if (lines.length <= maxLines && Array.from(output).length <= maxChars) return output;

  const lastLines = lines.slice(-maxLines);
  let result = lastLines.join("\n");

  if (Array.from(result).length > maxChars) {
    result = sliceLastCharacters(result, maxChars);
    const newlineIndex = result.indexOf("\n");
    if (newlineIndex > 0) {
      result = result.slice(newlineIndex + 1);
    }
  }

  return `...[output truncated]\n${result}`;
}

export async function runCommandTool(input: {
  butlerHome?: string;
  butlerData: string;
  workspacePath: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  commandExecutor?: CommandExecutor;
}): Promise<Record<string, unknown>> {
  throwIfCommandAborted(input.signal);
  const command = typeof input.args.command === "string" ? input.args.command.trim() : "";
  if (!command) throw new Error("run_command requires command");
  const cwd = commandWorkingDirectory({
    workspacePath: input.workspacePath,
    cwd: input.args.cwd,
  });
  const timeoutMs = boundedInteger(input.args.timeout_ms, {
    fallback: DEFAULT_COMMAND_TIMEOUT_MS,
    min: 1_000,
    max: MAX_COMMAND_TIMEOUT_MS,
  });
  const maxModelTokens = boundedInteger(input.args.max_output_tokens, {
    fallback: 1_200,
    min: 200,
    max: 8_000,
  });
  const outputMode = typeof input.args.output_mode === "string" &&
    ["auto", "silent_on_success", "full"].includes(input.args.output_mode)
    ? input.args.output_mode
    : "auto";

  const workspace = resolve(input.workspacePath);
  const projectLedgerGuard = projectLedgerCommandMutationGuard({
    command,
    cwd,
    workspacePath: workspace,
    butlerData: input.butlerData,
    butlerHome: input.butlerHome,
  });
  if (projectLedgerGuard) {
    return {
      ok: false,
      command,
      cwd,
      exit_code: 1,
      timed_out: false,
      stdout: "",
      stderr: projectLedgerGuard.message,
      error: projectLedgerGuard.error,
      protected_path: projectLedgerGuard.protected_path,
      next: projectLedgerGuard.next,
      evidence_receipts: commandEvidenceReceipts({ success: false, artifacts: [] }),
      evidence_capability_receipts: commandEvidenceCapabilityReceipts({
        exitCode: 1,
        timedOut: false,
        outputSuppressed: false,
        outputBudgeted: false,
      }),
    };
  }
  const commandExecutor = input.commandExecutor ?? createPlatformCommandExecutor();
  const gitStatusBeforeCommand = await gitWorkspaceStatusSnapshot(
    workspace,
    commandExecutor,
  );
  const commandStartedAtMs = Date.now();
  mkdirSync(commandGeneratedArtifactRoot(input.butlerData), { recursive: true });
  const projectLedgerSnapshot = createProjectLedgerMutationSnapshot({
    command,
    cwd,
    workspacePath: workspace,
    butlerData: input.butlerData,
    butlerHome: input.butlerHome,
  });
  let raw: ShellCommandResult;
  let projectLedgerMutation: ReturnType<
    typeof restoreProjectLedgerMutationIfChanged
  >;
  try {
    raw = await executeCommandCompatibility({
      command,
      cwd,
      timeoutMs,
      butlerData: input.butlerData,
      pipefail: Boolean(validationSuiteFromArgs(input.args)),
      signal: input.signal,
      commandExecutor,
    });
    projectLedgerMutation = restoreProjectLedgerMutationIfChanged(
      projectLedgerSnapshot,
    );
  } finally {
    cleanupProjectLedgerMutationSnapshot(projectLedgerSnapshot);
  }
  throwIfCommandAborted(input.signal);
  if (projectLedgerMutation) {
    return {
      ok: false,
      command,
      cwd,
      exit_code: 1,
      timed_out: false,
      stdout: "",
      stderr: projectLedgerMutation.message,
      error: projectLedgerMutation.error,
      protected_path: projectLedgerMutation.protected_path,
      next: projectLedgerMutation.next,
      evidence_receipts: commandEvidenceReceipts({ success: false, artifacts: [] }),
      evidence_capability_receipts: commandEvidenceCapabilityReceipts({
        exitCode: 1,
        timedOut: false,
        outputSuppressed: false,
        outputBudgeted: false,
      }),
    };
  }

  const success = raw.exit_code === 0 && raw.timed_out === false;
  const shouldSuppressOutput = success && (
    outputMode === "silent_on_success" ||
    (outputMode === "auto" && Boolean(validationSuiteFromArgs(input.args)))
  );

  let processedResult = raw;
  if (shouldSuppressOutput) {
    processedResult = {
      stdout: "",
      stderr: "",
      exit_code: raw.exit_code,
      timed_out: raw.timed_out,
    };
  } else if (!success && (outputMode === "silent_on_success" || outputMode === "auto")) {
    processedResult = {
      stdout: boundOutputOnFailure(raw.stdout),
      stderr: boundOutputOnFailure(raw.stderr),
      exit_code: raw.exit_code,
      timed_out: raw.timed_out,
    };
  }

  const budgeted = budgetToolOutput({
    result: processedResult,
    butlerData: input.butlerData,
    command,
    cwd,
    maxModelTokens,
  });
  const declaredArtifacts = declaredCommandArtifacts(input.args, cwd, workspace, input.butlerData);
  const stdoutArtifacts = declaredArtifacts.length > 0
    ? []
    : structuredStdoutCommandArtifacts({
      stdout: raw.stdout,
      cwd,
      workspace,
      butlerData: input.butlerData,
    });
  const discoveredGeneratedArtifacts = declaredArtifacts.length > 0 || stdoutArtifacts.length > 0
    ? []
    : recentCommandArtifacts({
      cwd,
      workspace,
      butlerData: input.butlerData,
      startedAtMs: commandStartedAtMs,
    });
  const discoveredWorkspaceArtifacts = declaredArtifacts.length > 0 || stdoutArtifacts.length > 0
    ? []
    : await gitWorkspaceDeltaArtifacts({
      before: gitStatusBeforeCommand,
      workspace,
      butlerData: input.butlerData,
      success,
      executor: commandExecutor,
    });
  const artifacts = uniqueCommandArtifacts([
    ...declaredArtifacts,
    ...stdoutArtifacts,
    ...discoveredGeneratedArtifacts,
    ...discoveredWorkspaceArtifacts,
  ]);
  const artifactEvidence = commandArtifactEvidenceFields(artifacts);
  throwIfCommandAborted(input.signal);
  return {
    ok: budgeted.exit_code === 0 && budgeted.timed_out === false,
    command,
    cwd,
    exit_code: budgeted.exit_code,
    timed_out: budgeted.timed_out,
    stdout: budgeted.stdout,
    stderr: budgeted.stderr,
    ...(budgeted.butler_tool_artifact
      ? { butler_tool_artifact: budgeted.butler_tool_artifact }
      : {}),
    ...artifactEvidence,
    evidence_receipts: commandEvidenceReceipts({
      success: budgeted.exit_code === 0 && budgeted.timed_out === false,
      artifacts,
    }),
    evidence_capability_receipts: commandEvidenceCapabilityReceipts({
      exitCode: budgeted.exit_code,
      timedOut: budgeted.timed_out,
      outputSuppressed: shouldSuppressOutput,
      outputBudgeted: Boolean(budgeted.butler_tool_artifact),
      artifacts,
      validations: commandValidationEvidence(input.args, raw),
    }),
  };
}

function commandValidationEvidence(
  args: Record<string, unknown>,
  result: ShellCommandResult,
): CommandValidationEvidence[] {
  const structured = structuredStdoutValidationEvidence(result.stdout);
  const declared = declaredValidationEvidence(args, result, structured);
  return [...structured, ...declared].slice(0, 8);
}

function declaredValidationEvidence(
  args: Record<string, unknown>,
  result: ShellCommandResult,
  existing: CommandValidationEvidence[],
): CommandValidationEvidence[] {
  const suite = validationSuiteFromArgs(args);
  if (!suite) return [];
  if (existing.some((validation) => validation.suite === suite)) return [];
  const passed = result.exit_code === 0 && result.timed_out === false;
  return [{
    suite,
    result: passed ? "passed" : "failed",
    ...(passed ? {} : { failure_summary: validationFailureSummary(result) }),
  }];
}

function validationSuiteFromArgs(args: Record<string, unknown>): string | null {
  return typeof args.validation_suite === "string" && args.validation_suite.trim()
    ? args.validation_suite.trim()
    : null;
}

function validationFailureSummary(result: ShellCommandResult): string {
  if (result.timed_out) return "Validation command timed out.";
  return `Validation command exited with status ${result.exit_code ?? "unknown"}.`;
}
