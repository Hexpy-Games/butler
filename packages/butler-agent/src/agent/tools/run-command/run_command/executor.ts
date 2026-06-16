import { spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "fs";
import { extname, isAbsolute, join, relative, resolve } from "path";
import { budgetToolOutput, type ShellCommandResult } from "../../../context/tool-output-budgeter.ts";
import type { EvidenceReceipt, PublicWorkObligationKind } from "../../../turn/native-tool-types.ts";
import { butlerToolProcessEnvironment, evidenceReceipt } from "../../../tool-support/executor-support.ts";

type ToolCall = { args: Record<string, unknown> };

export function createRunCommandToolHandlers(input: {
  butlerData: string;
  workspacePath: string;
}) {
  return {
    "run_command": async (call: ToolCall) => await runCommandTool({
      butlerData: input.butlerData,
      workspacePath: input.workspacePath,
      args: call.args,
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

interface CommandArtifactEvidence {
  path: string;
  artifact_kind: CommandArtifactKind;
  size_bytes: number;
  modified_at: string;
}

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

function commandArtifactMediaType(artifact: CommandArtifactEvidence): string {
  const ext = extname(artifact.path).toLocaleLowerCase("en-US");
  if (artifact.artifact_kind === "csv_file") return "text/csv";
  if (artifact.artifact_kind === "table_file") return "text/tab-separated-values";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function commandArtifactRole(artifact: CommandArtifactEvidence): string {
  if (artifact.artifact_kind === "csv_file" || artifact.artifact_kind === "table_file") return "table";
  if (artifact.artifact_kind === "chart_file") return "chart";
  return "file";
}

function commandEvidenceReceipts(input: {
  success: boolean;
  artifacts: CommandArtifactEvidence[];
}): EvidenceReceipt[] {
  const receipts: EvidenceReceipt[] = [
    evidenceReceipt({
      producerName: "run_command",
      receiptType: "execution",
      summary: input.success
        ? "A local command executed successfully."
        : "A local command was executed but did not complete successfully.",
      covers: ["execution_result"],
      verified: input.success,
      satisfies: input.success ? ["command_executed"] : [],
    }),
  ];
  if (input.artifacts.length > 0) {
    const satisfies = new Set<PublicWorkObligationKind>(["durable_artifact"]);
    if (input.artifacts.some((artifact) =>
      artifact.artifact_kind === "csv_file" || artifact.artifact_kind === "table_file",
    )) {
      satisfies.add("data_table_created");
    }
    if (input.artifacts.some((artifact) => artifact.artifact_kind === "chart_file")) {
      satisfies.add("chart_rendered");
    }
    receipts.push(evidenceReceipt({
      producerName: "run_command",
      receiptType: "deliverable",
      summary: "The command produced verified durable output file evidence.",
      covers: ["durable_deliverable"],
      artifacts: input.artifacts.map((artifact) => ({
        label: artifact.path,
        path: artifact.path,
        mediaType: commandArtifactMediaType(artifact),
        role: commandArtifactRole(artifact),
      })),
      satisfies: [...satisfies],
      metrics: {
        artifact_count: input.artifacts.length,
      },
    }));
  }
  return receipts;
}

function appendCapturedText(current: string, chunk: Buffer | string): {
  text: string;
  truncated: boolean;
} {
  if (current.length >= MAX_COMMAND_CAPTURE_CHARS) return { text: current, truncated: true };
  const next = current + chunk.toString();
  if (next.length <= MAX_COMMAND_CAPTURE_CHARS) return { text: next, truncated: false };
  return {
    text: next.slice(0, MAX_COMMAND_CAPTURE_CHARS),
    truncated: true,
  };
}

async function executeBashCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  butlerData: string;
}): Promise<ShellCommandResult> {
  return await new Promise((resolveCommand, reject) => {
    const child = spawn("/bin/bash", ["-lc", input.command], {
      cwd: input.cwd,
      env: butlerToolProcessEnvironment({ butlerData: input.butlerData }),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 500).unref?.();
    }, input.timeoutMs);

    child.stdout.on("data", (chunk) => {
      const next = appendCapturedText(stdout, chunk);
      stdout = next.text;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const next = appendCapturedText(stderr, chunk);
      stderr = next.text;
      stderrTruncated ||= next.truncated;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const truncationNotes = [
        stdoutTruncated ? `[stdout truncated after ${MAX_COMMAND_CAPTURE_CHARS} chars]` : "",
        stderrTruncated ? `[stderr truncated after ${MAX_COMMAND_CAPTURE_CHARS} chars]` : "",
      ].filter(Boolean);
      resolveCommand({
        stdout: stdoutTruncated ? `${stdout}\n${truncationNotes[0] ?? ""}` : stdout,
        stderr: stderrTruncated ? `${stderr}\n${truncationNotes.at(-1) ?? ""}` : stderr,
        exit_code: timedOut ? null : code,
        timed_out: timedOut,
      });
    });
  });
}

function isValidationCommand(command: string): boolean {
  const trimmed = command
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/u, "");
  const validationPatterns = [
    /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+check(?::run|:verbose)?\b/,
    /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+test:unit(?::run)?\b/,
    /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+test\b/,
    /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+ops\/scripts\/validate\.ts\s+(?:check:run|test:unit:run)\b/,
    /^bun\s+test\b/,
    /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+lint\b/,
    /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+typecheck\b/,
    /^npm\s+--prefix\s+\S+\s+run(?:\s+--silent)?\s+(?:lint|typecheck|test)\b/,
    /^(?:project-ledger|packages\/project-ledger\/bin\/project-ledger|resources\/skills\/project-ledger\/bin\/project-ledger)\s+check\b/,
    /^git\s+diff\b.*\s--check\b/,
  ];
  return validationPatterns.some((pattern) => pattern.test(trimmed));
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
  butlerData: string;
  workspacePath: string;
  args: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
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

  const commandStartedAtMs = Date.now();
  mkdirSync(commandGeneratedArtifactRoot(input.butlerData), { recursive: true });
  const raw = await executeBashCommand({
    command,
    cwd,
    timeoutMs,
    butlerData: input.butlerData,
  });

  const success = raw.exit_code === 0 && raw.timed_out === false;
  const shouldSuppressOutput = success && (
    outputMode === "silent_on_success" ||
    (outputMode === "auto" && isValidationCommand(command))
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
  const workspace = resolve(input.workspacePath);
  const declaredArtifacts = declaredCommandArtifacts(input.args, cwd, workspace, input.butlerData);
  const stdoutArtifacts = declaredArtifacts.length > 0
    ? []
    : structuredStdoutCommandArtifacts({
      stdout: raw.stdout,
      cwd,
      workspace,
      butlerData: input.butlerData,
    });
  const discoveredArtifacts = declaredArtifacts.length > 0 || stdoutArtifacts.length > 0
    ? []
    : recentCommandArtifacts({
      cwd,
      workspace,
      butlerData: input.butlerData,
      startedAtMs: commandStartedAtMs,
    });
  const artifacts = uniqueCommandArtifacts([
    ...declaredArtifacts,
    ...stdoutArtifacts,
    ...discoveredArtifacts,
  ]);
  const artifactEvidence = commandArtifactEvidenceFields(artifacts);
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
  };
}
