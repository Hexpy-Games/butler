import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import {
  estimateContextTokens,
  trimTextToTokenBudget,
} from "./budget.ts";
import { TOOL_EVIDENCE_REHYDRATION_SCHEMA } from "./tool-evidence-retention.ts";

export interface ShellCommandResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}

export interface ToolOutputArtifact {
  id: string;
  path: string;
  raw_tokens: number;
  compact_tokens: number;
  created_at: string;
  command?: string;
}

export interface BudgetedToolOutput extends ShellCommandResult {
  butler_tool_artifact?: ToolOutputArtifact;
}

export interface ToolOutputArtifactSlice {
  text: string;
  start_line: number;
  returned_lines: number;
  total_lines: number;
  estimated_tokens: number;
  truncated_by_lines: boolean;
  truncated_by_tokens: boolean;
}

export interface FocusedToolOutputArtifactRead {
  schema_version?: typeof TOOL_EVIDENCE_REHYDRATION_SCHEMA;
  terminal_evidence_observation?: true;
  ok: boolean;
  error?: string;
  rawTextStored: false;
  artifact?: {
    id: string;
    path: string;
    created_at: string | null;
    command: string | null;
    cwd: string | null;
    raw_tokens: number | null;
  };
  stdout?: ToolOutputArtifactSlice;
  stderr?: ToolOutputArtifactSlice;
}

export interface ToolOutputPruneMetric {
  schema: "butler.tool-output-prune.v1";
  ts: number;
  scanned: number;
  deleted: number;
  bytesDeleted: number;
  remainingBytes: number;
  maxAgeMs: number;
  maxBytes: number;
  protectedCount: number;
  rawTextStored: false;
}

function getButlerData(explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function artifactsRoot(butlerData: string): string {
  return join(butlerData, "artifacts", "tool-output");
}

export function toolOutputArtifactsRoot(butlerData: string): string {
  return artifactsRoot(getButlerData(butlerData));
}

export function toolOutputPruneMetricsPath(butlerData: string): string {
  return join(getButlerData(butlerData), "metrics", "tool-output-prune.jsonl");
}

function todayDir(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function outputText(result: ShellCommandResult): string {
  return [
    result.stdout ? `stdout:\n${result.stdout}` : "",
    result.stderr ? `stderr:\n${result.stderr}` : "",
  ].filter(Boolean).join("\n\n");
}

function artifactId(command: string | undefined): string {
  const prefix = command ? "cmd" : "tool";
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

export function budgetToolOutput(input: {
  result: ShellCommandResult;
  butlerData?: string;
  command?: string;
  cwd?: string;
  maxModelTokens?: number;
  now?: Date;
}): BudgetedToolOutput {
  const maxModelTokens = Math.max(200, input.maxModelTokens ?? 1_200);
  const rawText = outputText(input.result);
  const rawTokens = estimateContextTokens(rawText);
  if (rawTokens <= maxModelTokens) return input.result;

  const butlerData = getButlerData(input.butlerData);
  const now = input.now ?? new Date();
  const id = artifactId(input.command);
  const dir = join(artifactsRoot(butlerData), todayDir(now));
  const path = join(dir, `${id}.json`);
  mkdirSync(dir, { recursive: true });

  const artifact = {
    schema: "butler.tool-output.v1",
    id,
    created_at: now.toISOString(),
    command: input.command ?? null,
    cwd: input.cwd ?? null,
    result: input.result,
    raw_tokens: rawTokens,
  };
  writeFileSync(path, JSON.stringify(artifact, null, 2), "utf8");

  const stdoutPreview = trimTextToTokenBudget(input.result.stdout, Math.floor(maxModelTokens * 0.55), { from: "start" });
  const stderrPreview = trimTextToTokenBudget(input.result.stderr, Math.floor(maxModelTokens * 0.25), { from: "start" });
  const notice = [
    `[Butler compacted ${rawTokens.toLocaleString("en-US")} estimated tool-output tokens into a preview.]`,
    `Artifact ID: ${id}`,
    `Artifact path: ${path}`,
    "Ask for a focused artifact slice if the preview is insufficient.",
  ].join("\n");
  const compact: BudgetedToolOutput = {
    stdout: [notice, stdoutPreview ? `stdout preview:\n${stdoutPreview}` : ""].filter(Boolean).join("\n\n"),
    stderr: stderrPreview ? `stderr preview:\n${stderrPreview}` : "",
    exit_code: input.result.exit_code,
    timed_out: input.result.timed_out,
  };
  const compactTokens = estimateContextTokens(outputText(compact));
  compact.butler_tool_artifact = {
    id,
    path,
    raw_tokens: rawTokens,
    compact_tokens: compactTokens,
    created_at: now.toISOString(),
    command: input.command,
  };
  return compact;
}

export function readToolOutputArtifact(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isUnderRoot(path: string, root: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedRoot = resolve(root);
  const lexicalRel = relative(normalizedRoot, normalizedPath);
  const lexicallyUnderRoot = lexicalRel === "" || (!!lexicalRel && !lexicalRel.startsWith("..") && !isAbsolute(lexicalRel));
  if (!lexicallyUnderRoot) return false;

  const realRoot = existsSync(normalizedRoot) ? realpathSync.native(normalizedRoot) : normalizedRoot;
  const realPath = existsSync(normalizedPath) ? realpathSync.native(normalizedPath) : normalizedPath;
  const realRel = relative(realRoot, realPath);
  return realRel === "" || (!!realRel && !realRel.startsWith("..") && !isAbsolute(realRel));
}

function artifactResult(artifact: Record<string, any>): ShellCommandResult | null {
  const result = artifact.result;
  if (!result || typeof result !== "object") return null;
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exit_code: typeof result.exit_code === "number" || result.exit_code === null ? result.exit_code : null,
    timed_out: result.timed_out === true,
  };
}

function artifactMetadata(path: string, artifact: Record<string, any>): FocusedToolOutputArtifactRead["artifact"] {
  return {
    id: typeof artifact.id === "string" ? artifact.id : artifactDisplayName(path),
    path,
    created_at: typeof artifact.created_at === "string" ? artifact.created_at : null,
    command: typeof artifact.command === "string" ? artifact.command : null,
    cwd: typeof artifact.cwd === "string" ? artifact.cwd : null,
    raw_tokens: typeof artifact.raw_tokens === "number" ? artifact.raw_tokens : null,
  };
}

function findArtifactById(root: string, id: string, maxScanFiles: number): {
  ok: true;
  path: string | null;
} | {
  ok: false;
  error: "artifact_scan_limit_exceeded";
} {
  const safeId = id.trim();
  if (!safeId || /[/\\]/.test(safeId)) return { ok: true, path: null };
  const files = walkFiles(root, maxScanFiles + 1);
  if (files.length > maxScanFiles) {
    return {
      ok: false,
      error: "artifact_scan_limit_exceeded",
    };
  }
  for (const path of files) {
    if (!path.endsWith(".json")) continue;
    const artifact = readToolOutputArtifact(path);
    if (artifact && artifact.id === safeId) return { ok: true, path };
  }
  return { ok: true, path: null };
}

function resolveArtifactReference(input: {
  butlerData?: string;
  artifactId?: string;
  path?: string;
  maxScanFiles?: number;
}): { ok: true; root: string; path: string } | { ok: false; error: string; root: string } {
  const root = artifactsRoot(getButlerData(input.butlerData));
  if (input.path && input.path.trim()) {
    const artifactPath = resolve(input.path.trim());
    if (!isUnderRoot(artifactPath, root)) return { ok: false, error: "unsafe_artifact_path", root };
    return { ok: true, root, path: artifactPath };
  }
  if (input.artifactId && input.artifactId.trim()) {
    const found = findArtifactById(root, input.artifactId, Math.max(1, input.maxScanFiles ?? 10_000));
    if (!found.ok) return { ok: false, error: found.error, root };
    if (!found.path) return { ok: false, error: "artifact_not_found", root };
    return { ok: true, root, path: found.path };
  }
  return { ok: false, error: "artifact_reference_required", root };
}

function sliceStreamText(input: {
  text: string;
  offsetLines: number;
  limitLines: number;
  maxTokens: number;
}): ToolOutputArtifactSlice {
  const lines = input.text.split(/\r?\n/);
  const offset = Math.max(0, Math.min(lines.length, input.offsetLines));
  const limit = Math.max(1, input.limitLines);
  const selected = lines.slice(offset, offset + limit);
  const lineLimitedText = selected.join("\n");
  const tokenLimitedText = trimTextToTokenBudget(lineLimitedText, Math.max(1, input.maxTokens), { from: "start" });
  const tokenLimitedLines = tokenLimitedText ? tokenLimitedText.split(/\r?\n/) : [];
  return {
    text: tokenLimitedText,
    start_line: offset,
    returned_lines: tokenLimitedLines.length,
    total_lines: lines.length,
    estimated_tokens: estimateContextTokens(tokenLimitedText),
    truncated_by_lines: offset + selected.length < lines.length,
    truncated_by_tokens: tokenLimitedText.length < lineLimitedText.length,
  };
}

export function readToolOutputArtifactSlice(input: {
  butlerData?: string;
  artifactId?: string;
  path?: string;
  stream?: "stdout" | "stderr" | "both";
  offsetLines?: number;
  limitLines?: number;
  maxTokens?: number;
  maxArtifactScanFiles?: number;
}): FocusedToolOutputArtifactRead {
  const resolved = resolveArtifactReference({
    ...input,
    maxScanFiles: input.maxArtifactScanFiles,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error,
      rawTextStored: false,
    };
  }
  if (!existsSync(resolved.path)) {
    return {
      ok: false,
      error: "artifact_not_found",
      rawTextStored: false,
    };
  }
  const artifact = readToolOutputArtifact(resolved.path);
  if (!artifact) {
    return {
      ok: false,
      error: "artifact_unreadable",
      rawTextStored: false,
    };
  }
  const result = artifactResult(artifact);
  if (!result) {
    return {
      ok: false,
      error: "artifact_invalid",
      rawTextStored: false,
    };
  }

  const stream = input.stream ?? "both";
  const offsetLines = typeof input.offsetLines === "number" ? Math.max(0, Math.trunc(input.offsetLines)) : 0;
  const limitLines = typeof input.limitLines === "number" ? Math.max(1, Math.min(500, Math.trunc(input.limitLines))) : 80;
  const maxTokens = typeof input.maxTokens === "number" ? Math.max(50, Math.min(8_000, Math.trunc(input.maxTokens))) : 1_200;
  const stdoutHasText = result.stdout.trim().length > 0;
  const stderrHasText = result.stderr.trim().length > 0;
  const stdoutTokens = stream === "both" && stderrHasText
    ? Math.max(25, Math.floor(maxTokens / 2))
    : maxTokens;
  const stderrTokens = stream === "both" && stdoutHasText
    ? Math.max(25, Math.floor(maxTokens / 2))
    : maxTokens;
  const output: FocusedToolOutputArtifactRead = {
    schema_version: TOOL_EVIDENCE_REHYDRATION_SCHEMA,
    terminal_evidence_observation: true,
    ok: true,
    rawTextStored: false,
    artifact: artifactMetadata(resolved.path, artifact),
  };
  if (stream === "stdout" || stream === "both") {
    output.stdout = sliceStreamText({
      text: result.stdout,
      offsetLines,
      limitLines,
      maxTokens: stdoutTokens,
    });
  }
  if (stream === "stderr" || stream === "both") {
    output.stderr = sliceStreamText({
      text: result.stderr,
      offsetLines,
      limitLines,
      maxTokens: stderrTokens,
    });
  }
  return output;
}

function walkFiles(root: string, maxFiles = Number.POSITIVE_INFINITY): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    if (out.length >= maxFiles) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= maxFiles) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  visit(root);
  return out;
}

export function pruneToolOutputArtifacts(input: {
  butlerData?: string;
  maxAgeMs?: number;
  maxBytes?: number;
  protectedPaths?: string[];
  now?: Date;
  recordTelemetry?: boolean;
} = {}): {
  scanned: number;
  deleted: number;
  bytesDeleted: number;
  remainingBytes: number;
  maxAgeMs: number;
  maxBytes: number;
  rawTextStored: false;
} {
  const butlerData = getButlerData(input.butlerData);
  const root = artifactsRoot(butlerData);
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const maxAgeMs = Math.max(0, input.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000);
  const maxBytes = Math.max(0, input.maxBytes ?? 512 * 1024 * 1024);
  const protectedPaths = new Set((input.protectedPaths ?? []).map((path) => resolve(path)));
  const files = walkFiles(root)
    .map((path) => {
      const stat = statSync(path);
      return {
        path,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  let deleted = 0;
  let bytesDeleted = 0;

  for (const file of files) {
    if (protectedPaths.has(resolve(file.path))) continue;
    const tooOld = nowMs - file.mtimeMs > maxAgeMs;
    const overBudget = totalBytes > maxBytes;
    if (!tooOld && !overBudget) continue;
    rmSync(file.path, { force: true });
    deleted += 1;
    bytesDeleted += file.size;
    totalBytes -= file.size;
    try {
      const parent = dirname(file.path);
      if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  const result = {
    scanned: files.length,
    deleted,
    bytesDeleted,
    remainingBytes: totalBytes,
    maxAgeMs,
    maxBytes,
    rawTextStored: false as const,
  };

  if (input.recordTelemetry) {
    const metric: ToolOutputPruneMetric = {
      schema: "butler.tool-output-prune.v1",
      ts: nowMs,
      scanned: result.scanned,
      deleted: result.deleted,
      bytesDeleted: result.bytesDeleted,
      remainingBytes: result.remainingBytes,
      maxAgeMs,
      maxBytes,
      protectedCount: protectedPaths.size,
      rawTextStored: false,
    };
    const metricsPath = toolOutputPruneMetricsPath(butlerData);
    mkdirSync(dirname(metricsPath), { recursive: true });
    appendFileSync(metricsPath, `${JSON.stringify(metric)}\n`, "utf8");
  }

  return result;
}

export function artifactDisplayName(path: string): string {
  return basename(path);
}

export function readToolOutputPruneMetrics(butlerData: string): ToolOutputPruneMetric[] {
  const path = toolOutputPruneMetricsPath(butlerData);
  if (!existsSync(path)) return [];
  const events: ToolOutputPruneMetric[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ToolOutputPruneMetric;
      if (parsed?.schema === "butler.tool-output-prune.v1") events.push(parsed);
    } catch {
      continue;
    }
  }
  return events;
}
