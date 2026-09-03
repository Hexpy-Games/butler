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
import { estimateContextTokens } from "./budget.ts";
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
  output_presentation?: {
    mode: "auto" | "silent_on_success" | "full";
    requested_max_tokens: number | null;
    applied_max_tokens: number;
    suppressed: boolean;
    truncated: boolean;
  };
}

export interface ToolOutputArtifactSlice {
  text: string;
  start_line: number;
  returned_lines: number;
  total_lines: number;
  estimated_tokens: number;
  truncated_by_lines: boolean;
  truncated_by_tokens: boolean;
  start_char: number;
  next_offset_chars: number | null;
  total_chars: number;
  applied_max_tokens: number;
  search?: { query: string; found: boolean; match_char: number | null };
}

export interface FocusedToolOutputArtifactRead {
  schema_version?: typeof TOOL_EVIDENCE_REHYDRATION_SCHEMA;
  terminal_evidence_observation?: true;
  ok: boolean;
  error?: string;
  rawTextStored: false;
  limits?: {
    requested_max_tokens: number | null;
    applied_max_tokens: number;
    requested_limit_lines: number | null;
    applied_limit_lines: number;
  };
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
  outputMode?: unknown;
  validationSuite?: unknown;
  now?: Date;
}): BudgetedToolOutput {
  const requestedTokens = typeof input.maxModelTokens === "number" && Number.isFinite(input.maxModelTokens)
    ? input.maxModelTokens : null;
  const maxModelTokens = Math.max(200, Math.min(8_000, Math.trunc(requestedTokens ?? 1_200)));
  const mode = input.outputMode === "full" || input.outputMode === "silent_on_success"
    ? input.outputMode : "auto";
  const success = input.result.exit_code === 0 && !input.result.timed_out;
  const suppressed = success && (mode === "silent_on_success" ||
    (mode === "auto" && typeof input.validationSuite === "string" && Boolean(input.validationSuite.trim())));
  const preview = suppressed
    ? { ...input.result, stdout: "", stderr: "" }
    : !success && mode !== "full" && input.outputMode !== undefined
      ? { ...input.result, stdout: failureOutputPreview(input.result.stdout), stderr: failureOutputPreview(input.result.stderr) }
      : input.result;
  const presentation: NonNullable<BudgetedToolOutput["output_presentation"]> = {
    mode,
    requested_max_tokens: requestedTokens,
    applied_max_tokens: maxModelTokens,
    suppressed,
    truncated: preview.stdout !== input.result.stdout || preview.stderr !== input.result.stderr,
  };
  const rawText = outputText(input.result);
  const rawTokens = estimateContextTokens(rawText);
  if (rawTokens <= maxModelTokens && !presentation.truncated) {
    return input.outputMode === undefined ? input.result : { ...input.result, output_presentation: presentation };
  }

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

  const previewNeedsBudget = estimateContextTokens(outputText(preview)) > maxModelTokens;
  const notice = [
    `[Butler compacted ${rawTokens.toLocaleString("en-US")} estimated tool-output tokens into a preview.]`,
    `Artifact ID: ${id}`,
    "Use read_tool_output_artifact with search or a focused slice for omitted output.",
  ].join("\n");
  const compact: BudgetedToolOutput = {
    ...(previewNeedsBudget ? fitOutputPreview(preview, notice, maxModelTokens) : preview),
    exit_code: input.result.exit_code,
    timed_out: input.result.timed_out,
    output_presentation: { ...presentation, truncated: true },
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

function fitOutputPreview(result: ShellCommandResult, notice: string, maxTokens: number): ShellCommandResult {
  const preview = { ...result, stdout: notice, stderr: "" };
  const stderrText = (value: string) => value ? `stderr preview:\n${value}` : "";
  const stderrLength = prefixLengthWithinBudget(result.stderr, Math.floor(maxTokens * 0.45), (value) =>
    outputText({ ...preview, stderr: stderrText(value) }),
  );
  preview.stderr = stderrText(result.stderr.slice(0, stderrLength));
  const stdoutText = (value: string) => value ? `${notice}\n\nstdout preview:\n${value}` : notice;
  const stdoutLength = prefixLengthWithinBudget(result.stdout, maxTokens, (value) =>
    outputText({ ...preview, stdout: stdoutText(value) }),
  );
  preview.stdout = stdoutText(result.stdout.slice(0, stdoutLength));
  return preview;
}

/** Measure the exact rendered preview, including notices, stream labels and whitespace. */
function prefixLengthWithinBudget(text: string, maxTokens: number, render: (value: string) => string = (value) => value): number {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateContextTokens(render(text.slice(0, middle))) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return low;
}

function failureOutputPreview(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 20 && output.length <= 1_000) return output;
  return `...[output truncated]\n${lines.slice(-20).join("\n").slice(-1_000)}`;
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
  offsetChars?: number;
  search?: string;
  limitLines: number;
  maxTokens: number;
}): ToolOutputArtifactSlice {
  // Character offsets refer to the original UTF-16 string, including CRLF and whitespace.
  // A partial line is never skipped: the exclusive end is the next exact cursor.
  let start = Math.min(input.text.length, input.offsetChars ?? 0);
  if (input.offsetChars === undefined) {
    for (let line = 0; line < input.offsetLines && start < input.text.length; line += 1) {
      const newline = input.text.indexOf("\n", start);
      start = newline < 0 ? input.text.length : newline + 1;
    }
  }
  const match = input.search ? input.text.indexOf(input.search, start) : null;
  if (match !== null) start = match < 0 ? input.text.length : match;
  let lineEnd = start;
  for (let line = 0; line < input.limitLines && lineEnd < input.text.length; line += 1) {
    const newline = input.text.indexOf("\n", lineEnd);
    lineEnd = newline < 0 ? input.text.length : newline + 1;
  }
  const low = start + prefixLengthWithinBudget(input.text.slice(start, lineEnd), input.maxTokens);
  const text = input.text.slice(start, low);
  return {
    text,
    start_line: input.text.slice(0, start).split("\n").length - 1,
    returned_lines: text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0,
    total_lines: input.text.split("\n").length,
    estimated_tokens: estimateContextTokens(text),
    truncated_by_lines: lineEnd < input.text.length,
    truncated_by_tokens: low < lineEnd,
    start_char: start,
    next_offset_chars: low < input.text.length ? low : null,
    total_chars: input.text.length,
    applied_max_tokens: input.maxTokens,
    ...(input.search ? { search: { query: input.search, found: match !== -1, match_char: match === -1 ? null : match } } : {}),
  };
}

export function readToolOutputArtifactSlice(input: {
  butlerData?: string;
  artifactId?: string;
  path?: string;
  stream?: "stdout" | "stderr" | "both";
  offsetLines?: number;
  offsetChars?: number;
  search?: string;
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
  const offsetChars = typeof input.offsetChars === "number" && Number.isFinite(input.offsetChars)
    ? Math.max(0, Math.trunc(input.offsetChars)) : undefined;
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
    limits: {
      requested_max_tokens: input.maxTokens ?? null,
      applied_max_tokens: maxTokens,
      requested_limit_lines: input.limitLines ?? null,
      applied_limit_lines: limitLines,
    },
  };
  if (stream === "stdout" || stream === "both") {
    output.stdout = sliceStreamText({
      text: result.stdout,
      offsetLines,
      offsetChars,
      search: input.search,
      limitLines,
      maxTokens: stdoutTokens,
    });
  }
  if (stream === "stderr" || stream === "both") {
    output.stderr = sliceStreamText({
      text: result.stderr,
      offsetLines,
      offsetChars,
      search: input.search,
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
