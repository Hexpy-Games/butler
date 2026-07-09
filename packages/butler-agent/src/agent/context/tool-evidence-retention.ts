import { createHash, randomUUID } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, isAbsolute, join, relative, resolve } from "path";

export const RAW_TOOL_ARTIFACT_SCHEMA = "butler.raw-tool-artifact.v1";
export const EVIDENCE_PACKET_SCHEMA = "butler.evidence-packet.v1";

export interface ToolEvidenceRetentionContext {
  butlerData?: string;
  turnId?: string;
  semanticWorkBlockId?: string;
  now?: Date;
}

export interface RawToolArtifactReference {
  id: string;
  path: string;
  created_at: string;
  digest: string;
  raw_estimated_tokens: number;
}

export interface EvidencePacket {
  schema: typeof EVIDENCE_PACKET_SCHEMA;
  packet_id: string;
  artifact_id: string;
  tool_name: string;
  tool_call_id?: string;
  turn_id?: string;
  semantic_work_block_id?: string;
  created_at: string;
  digest: string;
  raw_estimated_tokens: number;
  subject: string | null;
  scope: string;
  facts: Record<string, unknown>;
  excerpt: string;
  truncation: {
    excerpt_estimated_tokens: number;
    raw_estimated_tokens: number;
    truncated: boolean;
  };
  rehydrate: {
    kind: "tool_evidence_artifact" | "unpersisted_tool_result";
    artifact_id: string;
    path?: string;
    tool: "read_tool_evidence_artifact";
    guidance: string;
  };
}

export interface RetainedToolEvidence {
  packet: EvidencePacket;
  artifact: RawToolArtifactReference | null;
}

export interface ToolEvidenceArtifactSlice {
  text: string;
  start_line: number;
  returned_lines: number;
  total_lines: number;
  estimated_tokens: number;
  truncated_by_lines: boolean;
  truncated_by_tokens: boolean;
}

export interface FocusedToolEvidenceArtifactRead {
  ok: boolean;
  error?: string;
  rawTextStored: false;
  artifact?: {
    id: string;
    path: string;
    created_at: string | null;
    tool_name: string | null;
    tool_call_id: string | null;
    turn_id: string | null;
    semantic_work_block_id: string | null;
    digest: string | null;
    raw_tokens: number | null;
  };
  text?: ToolEvidenceArtifactSlice;
}

function getButlerData(explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function artifactsRoot(butlerData?: string): string {
  return join(getButlerData(butlerData), "artifacts", "tool-evidence");
}

export function toolEvidenceArtifactsRoot(butlerData?: string): string {
  return artifactsRoot(butlerData);
}

function todayDir(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function serializeOutput(output: unknown): string {
  if (typeof output === "string") return output;
  const record = outputRecord(output);
  if (record) {
    const bodyKeys = new Set(["stdout", "stderr", "markdown", "text", "content"]);
    const metadata: Record<string, unknown> = {};
    const parts: string[] = [];
    for (const [key, value] of Object.entries(record)) {
      if (bodyKeys.has(key) && typeof value === "string") continue;
      metadata[key] = value;
    }
    if (Object.keys(metadata).length > 0) {
      parts.push(`metadata:\n${JSON.stringify(metadata, null, 2)}`);
    }
    for (const key of bodyKeys) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        parts.push(`${key}:\n${value}`);
      }
    }
    if (parts.length > 0) return parts.join("\n\n");
  }
  try {
    return JSON.stringify(output ?? null, null, 2);
  } catch {
    return String(output);
  }
}

function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fastEstimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function trimTextToFastTokenBudget(text: string, maxTokens: number): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (fastEstimateTokens(trimmed) <= maxTokens) return trimmed;
  return trimmed.slice(0, Math.max(1, Math.trunc(maxTokens) * 4)).trimEnd();
}

function compactString(value: unknown, maxLength = 400): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
}

function compactStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, limit);
}

function outputRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function summarizeFacts(output: unknown): Record<string, unknown> {
  const record = outputRecord(output);
  if (!record) return {};
  const facts: Record<string, unknown> = {};
  for (const key of [
    "ok",
    "exit_code",
    "timed_out",
    "query",
    "title",
    "source_url",
    "final_url",
    "artifact_id",
    "artifact_label",
    "artifact_kind",
    "artifact_path",
    "row_count",
    "cache_hit",
    "read_required",
    "read_reason",
  ]) {
    const value = record[key];
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      facts[key] = value;
    }
  }

  const sourceUrls = compactStringList(record.source_urls, 8);
  const recommendedReadUrls = compactStringList(record.recommended_read_urls, 6);
  const artifactLabels = compactStringList(record.artifact_labels, 8);
  if (sourceUrls.length > 0) facts.source_urls = sourceUrls;
  if (recommendedReadUrls.length > 0) facts.recommended_read_urls = recommendedReadUrls;
  if (artifactLabels.length > 0) facts.artifact_labels = artifactLabels;
  if (Array.isArray(record.evidence_receipts)) {
    facts.evidence_receipts_count = record.evidence_receipts.length;
  }
  if (typeof record.stdout === "string") facts.stdout_bytes = Buffer.byteLength(record.stdout, "utf8");
  if (typeof record.stderr === "string") facts.stderr_bytes = Buffer.byteLength(record.stderr, "utf8");
  return facts;
}

function inferSubject(output: unknown, toolName: string): string | null {
  const record = outputRecord(output);
  if (!record) return toolName;
  for (const key of [
    "artifact_path",
    "path",
    "file_path",
    "source_url",
    "final_url",
    "url",
    "query",
    "title",
    "command",
  ]) {
    const value = compactString(record[key]);
    if (value) return value;
  }
  return toolName;
}

function redactPrivateHints(text: string): string {
  let redacted = text.replaceAll(homedir(), "~");
  redacted = redacted.replace(/\/Users\/[^/\s"']+/g, "~");
  redacted = redacted.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "sk-REDACTED");
  redacted = redacted.replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "gh_REDACTED");
  redacted = redacted.replace(/(authorization\s*:\s*bearer\s+)[^\s"'\\]+/gi, "$1REDACTED");
  redacted = redacted.replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s"'\\]+/gi, "$1REDACTED");
  return redacted;
}

function bodyFieldStats(output: unknown): Array<{
  field: string;
  bytes: number;
  lines: number;
}> {
  const record = outputRecord(output);
  if (!record) {
    const text = typeof output === "string" ? output : serializeOutput(output);
    return [{
      field: "text",
      bytes: Buffer.byteLength(text, "utf8"),
      lines: text ? text.split(/\r?\n/).length : 0,
    }];
  }
  const out: Array<{ field: string; bytes: number; lines: number }> = [];
  for (const key of ["stdout", "stderr", "markdown", "text", "content"]) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) continue;
    out.push({
      field: key,
      bytes: Buffer.byteLength(value, "utf8"),
      lines: value.split(/\r?\n/).length,
    });
  }
  return out;
}

function evidenceExcerpt(input: {
  output: unknown;
  serialized: string;
  rawTokens: number;
  maxTokens: number;
}): string {
  const facts = summarizeFacts(input.output);
  const text = [
    "Tool evidence packet summary.",
    `raw_estimated_tokens: ${input.rawTokens}`,
    `serialized_bytes: ${Buffer.byteLength(input.serialized, "utf8")}`,
    Object.keys(facts).length > 0 ? `facts:\n${JSON.stringify(facts, null, 2)}` : "",
    bodyFieldStats(input.output).length > 0
      ? `body_fields:\n${JSON.stringify(bodyFieldStats(input.output), null, 2)}`
      : "",
    "Raw body text is omitted from this packet; use read_tool_evidence_artifact for exact bounded slices.",
  ].filter(Boolean).join("\n");
  return trimTextToFastTokenBudget(redactPrivateHints(text), Math.max(80, input.maxTokens));
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

function readJsonArtifact(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
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
    const artifact = readJsonArtifact(path);
    if (artifact?.schema === RAW_TOOL_ARTIFACT_SCHEMA && artifact.id === safeId) {
      return { ok: true, path };
    }
  }
  return { ok: true, path: null };
}

function resolveArtifactReference(input: {
  butlerData?: string;
  artifactId?: string;
  path?: string;
  maxScanFiles?: number;
}): { ok: true; path: string } | { ok: false; error: string } {
  const root = artifactsRoot(input.butlerData);
  if (input.path && input.path.trim()) {
    const artifactPath = resolve(input.path.trim());
    if (!isUnderRoot(artifactPath, root)) return { ok: false, error: "unsafe_artifact_path" };
    return { ok: true, path: artifactPath };
  }
  if (input.artifactId && input.artifactId.trim()) {
    const found = findArtifactById(root, input.artifactId, Math.max(1, input.maxScanFiles ?? 10_000));
    if (!found.ok) return { ok: false, error: found.error };
    if (!found.path) return { ok: false, error: "artifact_not_found" };
    return { ok: true, path: found.path };
  }
  return { ok: false, error: "artifact_reference_required" };
}

function artifactMetadata(path: string, artifact: Record<string, unknown>): FocusedToolEvidenceArtifactRead["artifact"] {
  return {
    id: typeof artifact.id === "string" ? artifact.id : basename(path),
    path,
    created_at: typeof artifact.created_at === "string" ? artifact.created_at : null,
    tool_name: typeof artifact.tool_name === "string" ? artifact.tool_name : null,
    tool_call_id: typeof artifact.tool_call_id === "string" ? artifact.tool_call_id : null,
    turn_id: typeof artifact.turn_id === "string" ? artifact.turn_id : null,
    semantic_work_block_id: typeof artifact.semantic_work_block_id === "string" ? artifact.semantic_work_block_id : null,
    digest: typeof artifact.digest === "string" ? artifact.digest : null,
    raw_tokens: typeof artifact.raw_estimated_tokens === "number" ? artifact.raw_estimated_tokens : null,
  };
}

function sliceText(input: {
  text: string;
  offsetLines: number;
  limitLines: number;
  maxTokens: number;
}): ToolEvidenceArtifactSlice {
  const lines = input.text.split(/\r?\n/);
  const offset = Math.max(0, Math.min(lines.length, input.offsetLines));
  const limit = Math.max(1, input.limitLines);
  const selected = lines.slice(offset, offset + limit);
  const lineLimitedText = selected.join("\n");
  const tokenLimitedText = trimTextToFastTokenBudget(lineLimitedText, Math.max(1, input.maxTokens));
  const tokenLimitedLines = tokenLimitedText ? tokenLimitedText.split(/\r?\n/) : [];
  return {
    text: tokenLimitedText,
    start_line: offset,
    returned_lines: tokenLimitedLines.length,
    total_lines: lines.length,
    estimated_tokens: fastEstimateTokens(tokenLimitedText),
    truncated_by_lines: offset + selected.length < lines.length,
    truncated_by_tokens: tokenLimitedText.length < lineLimitedText.length,
  };
}

export function retainToolEvidence(input: {
  context?: ToolEvidenceRetentionContext;
  toolName: string;
  toolCallId?: string;
  output: unknown;
  reason: string;
  rawTokens?: number;
  excerptMaxTokens?: number;
}): RetainedToolEvidence {
  const now = input.context?.now ?? new Date();
  const createdAt = now.toISOString();
  const serialized = serializeOutput(input.output);
  const digest = digestText(serialized);
  const rawTokens = input.rawTokens ?? fastEstimateTokens(serialized);
  const artifactId = `evidence_${randomUUID().slice(0, 12)}`;
  const excerpt = evidenceExcerpt({
    output: input.output,
    serialized,
    rawTokens,
    maxTokens: input.excerptMaxTokens ?? 300,
  });
  let artifact: RawToolArtifactReference | null = null;

  if (input.context?.butlerData) {
    const dir = join(artifactsRoot(input.context.butlerData), todayDir(now));
    const path = join(dir, `${artifactId}.json`);
    mkdirSync(dir, { recursive: true });
    const record = {
      schema: RAW_TOOL_ARTIFACT_SCHEMA,
      id: artifactId,
      created_at: createdAt,
      tool_name: input.toolName,
      tool_call_id: input.toolCallId ?? null,
      turn_id: input.context.turnId ?? null,
      semantic_work_block_id: input.context.semanticWorkBlockId ?? null,
      checkpoint_reason: input.reason,
      digest,
      raw_estimated_tokens: rawTokens,
      serialized_text: serialized,
      raw: input.output,
    };
    writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
    artifact = {
      id: artifactId,
      path,
      created_at: createdAt,
      digest,
      raw_estimated_tokens: rawTokens,
    };
  }

  const packet: EvidencePacket = {
    schema: EVIDENCE_PACKET_SCHEMA,
    packet_id: `packet_${randomUUID().slice(0, 12)}`,
    artifact_id: artifactId,
    tool_name: input.toolName,
    ...(input.toolCallId ? { tool_call_id: input.toolCallId } : {}),
    ...(input.context?.turnId ? { turn_id: input.context.turnId } : {}),
    ...(input.context?.semanticWorkBlockId ? { semantic_work_block_id: input.context.semanticWorkBlockId } : {}),
    created_at: createdAt,
    digest,
    raw_estimated_tokens: rawTokens,
    subject: inferSubject(input.output, input.toolName),
    scope: input.reason,
    facts: summarizeFacts(input.output),
    excerpt,
    truncation: {
      excerpt_estimated_tokens: fastEstimateTokens(excerpt),
      raw_estimated_tokens: rawTokens,
      truncated: fastEstimateTokens(excerpt) < rawTokens,
    },
    rehydrate: {
      kind: artifact ? "tool_evidence_artifact" : "unpersisted_tool_result",
      artifact_id: artifactId,
      ...(artifact ? { path: artifact.path } : {}),
      tool: "read_tool_evidence_artifact",
      guidance: "Use read_tool_evidence_artifact with artifact_id and bounded line/token limits before making claims that depend on omitted raw evidence.",
    },
  };

  return {
    packet,
    artifact,
  };
}

export function readToolEvidenceArtifactSlice(input: {
  butlerData?: string;
  artifactId?: string;
  path?: string;
  offsetLines?: number;
  limitLines?: number;
  maxTokens?: number;
  maxArtifactScanFiles?: number;
}): FocusedToolEvidenceArtifactRead {
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
  const artifact = readJsonArtifact(resolved.path);
  if (!artifact) {
    return {
      ok: false,
      error: "artifact_unreadable",
      rawTextStored: false,
    };
  }
  if (artifact.schema !== RAW_TOOL_ARTIFACT_SCHEMA || typeof artifact.serialized_text !== "string") {
    return {
      ok: false,
      error: "artifact_invalid",
      rawTextStored: false,
    };
  }

  const offsetLines = typeof input.offsetLines === "number" ? Math.max(0, Math.trunc(input.offsetLines)) : 0;
  const limitLines = typeof input.limitLines === "number" ? Math.max(1, Math.min(500, Math.trunc(input.limitLines))) : 80;
  const maxTokens = typeof input.maxTokens === "number" ? Math.max(50, Math.min(8_000, Math.trunc(input.maxTokens))) : 1_200;
  return {
    ok: true,
    rawTextStored: false,
    artifact: artifactMetadata(resolved.path, artifact),
    text: sliceText({
      text: artifact.serialized_text,
      offsetLines,
      limitLines,
      maxTokens,
    }),
  };
}
