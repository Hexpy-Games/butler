const MAX_CANDIDATE_PATHS = 24;
const MAX_MATCH_PREVIEWS = 12;
const MAX_MATCH_TEXT_CHARS = 240;
const MAX_FILE_CONTENT_CHARS = 4_800;
const WORK_BLOCK_TOOL_NAME = "run_work_block";

export function structuredToolResultModelPreview(input: {
  toolName: string;
  output: unknown;
}): Record<string, unknown> | null {
  if (input.toolName === WORK_BLOCK_TOOL_NAME) {
    const output = toolPayload(input.output, ["results"]);
    return output ? workBlockPreview(output) : null;
  }
  if (input.toolName === "grep_files") {
    const output = toolPayload(input.output, ["matches", "pattern"]);
    return output ? grepFilesPreview(output) : null;
  }
  if (input.toolName === "read_file") {
    const output = toolPayload(input.output, ["content", "path"]);
    return output ? readFilePreview(output) : null;
  }
  if (input.toolName === "read_tool_output_artifact") {
    const output = toolPayload(input.output, ["stdout", "stderr"]);
    return output ? toolOutputArtifactPreview(output) : null;
  }
  if (input.toolName === "read_tool_evidence_artifact") {
    const output = toolPayload(input.output, ["text", "artifact"]);
    return output ? toolEvidenceArtifactPreview(output) : null;
  }
  if (input.toolName === "run_command") {
    const output = toolPayload(input.output, ["model_visible_content", "exit_code"]);
    return output ? runCommandPreview(output) : null;
  }
  return genericToolPreview(input.toolName, input.output);
}

function toolOutputArtifactPreview(output: Record<string, unknown>): Record<string, unknown> {
  return compactUndefined({
    tool_name: "read_tool_output_artifact",
    ok: typeof output.ok === "boolean" ? output.ok : undefined,
    artifact: artifactIdentity(output.artifact),
    stdout: artifactSlice(output.stdout, 3_600),
    stderr: artifactSlice(output.stderr, 3_600),
    error: boundedText(output.error, 320),
  });
}

function toolEvidenceArtifactPreview(output: Record<string, unknown>): Record<string, unknown> {
  return compactUndefined({
    tool_name: "read_tool_evidence_artifact",
    ok: typeof output.ok === "boolean" ? output.ok : undefined,
    artifact: artifactIdentity(output.artifact),
    text: artifactSlice(output.text, 4_800),
    error: boundedText(output.error, 320),
  });
}

function artifactIdentity(value: unknown): Record<string, unknown> | undefined {
  const artifact = record(value);
  if (!artifact) return undefined;
  return compactUndefined({
    id: text(artifact.id),
    tool_name: text(artifact.tool_name),
    command: boundedText(artifact.command, 320),
    raw_tokens: finiteNumber(artifact.raw_tokens) ?? undefined,
  });
}

function artifactSlice(value: unknown, maxChars: number): Record<string, unknown> | undefined {
  const slice = record(value);
  if (!slice) return undefined;
  return compactUndefined({
    text: boundedHeadTailText(slice.text, maxChars),
    start_line: finiteNumber(slice.start_line) ?? undefined,
    returned_lines: finiteNumber(slice.returned_lines) ?? undefined,
    total_lines: finiteNumber(slice.total_lines) ?? undefined,
    truncated_by_lines: typeof slice.truncated_by_lines === "boolean"
      ? slice.truncated_by_lines
      : undefined,
    truncated_by_tokens: typeof slice.truncated_by_tokens === "boolean"
      ? slice.truncated_by_tokens
      : undefined,
  });
}

function runCommandPreview(output: Record<string, unknown>): Record<string, unknown> {
  return compactUndefined({
    tool_name: "run_command",
    ok: typeof output.ok === "boolean" ? output.ok : undefined,
    exit_code: finiteNumber(output.exit_code) ?? undefined,
    observation_kind: text(output.observation_kind),
    summary: boundedText(output.summary, 480),
    model_visible_content: boundedHeadTailText(output.model_visible_content, 2_000),
    stderr: boundedHeadTailText(output.stderr, 1_600),
    stdout: boundedHeadTailText(output.stdout, 1_200),
  });
}

function workBlockPreview(output: Record<string, unknown>): Record<string, unknown> {
  const results = Array.isArray(output.results) ? output.results : [];
  return {
    tool_name: WORK_BLOCK_TOOL_NAME,
    ...(record(output.frontier) ? { frontier: projectGenericRecord(record(output.frontier)!, 0) } : {}),
    results: results.slice(0, 6).flatMap((value) => {
      const result = record(value);
      const name = text(result?.name);
      if (!name) return [];
      const nested = result?.result ?? result?.output;
      return [{
        name,
        ok: result?.ok !== false,
        preview: structuredToolResultModelPreview({ toolName: name, output: nested }),
        ...(typeof result?.error === "string" ? { error: boundedText(result.error, 320) } : {}),
      }];
    }),
  };
}

function genericToolPreview(toolName: string, value: unknown): Record<string, unknown> | null {
  const payload = toolPayload(value, []);
  if (!payload) return null;
  const projected = projectGenericRecord(payload, 0);
  return Object.keys(projected).length > 0
    ? { tool_name: toolName, ...projected }
    : { tool_name: toolName };
}

const GENERIC_SAFE_KEYS = new Set([
  "ok", "id", "kind", "title", "status", "state", "path", "command", "action", "view",
  "issueCount", "issue_count", "staleViews", "created", "updated", "ignored", "reason",
  "list_id", "todo_list_id", "workstream_id", "work_stream_id", "project_id", "record_generation",
  "generation", "count", "counts", "progress", "results", "records", "nextActions", "next_actions",
  "items", "issues", "work_stream", "work_streams", "data", "error", "code", "message",
  "stage", "gated", "ledgerDiscoveryObserved", "ledgerDiscoveryCandidateCount", "requiredLedgerKinds", "observedLedgerKinds", "ledgerCheckPassed",
]);

function projectGenericRecord(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth > 3) return {};
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!GENERIC_SAFE_KEYS.has(key)) continue;
    const projected = projectGenericValue(item, key, depth + 1);
    if (projected !== undefined) result[key] = projected;
  }
  return result;
}

function projectGenericValue(value: unknown, key: string, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (key === "path") return boundedText(value, 240);
    return boundedText(value, 320);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => {
      const itemRecord = record(item);
      return itemRecord ? projectGenericRecord(itemRecord, depth) : projectGenericValue(item, key, depth);
    });
  }
  const valueRecord = record(value);
  return valueRecord ? projectGenericRecord(valueRecord, depth) : undefined;
}

function grepFilesPreview(output: Record<string, unknown>): Record<string, unknown> {
  const matches = Array.isArray(output.matches)
    ? output.matches.flatMap((value) => {
      const match = record(value);
      const path = text(match?.path);
      const line = finiteNumber(match?.line);
      if (!path || line === null) return [];
      return [{
        path,
        line,
        text: boundedText(match?.text, MAX_MATCH_TEXT_CHARS),
      }];
    })
    : [];
  const candidatePaths = [...new Set(matches.map((match) => match.path))]
    .slice(0, MAX_CANDIDATE_PATHS);
  return compactUndefined({
    tool_name: "grep_files",
    pattern: text(output.pattern),
    match_count: matches.length,
    candidate_paths: candidatePaths,
    matches: matches.slice(0, MAX_MATCH_PREVIEWS),
    files_searched: finiteNumber(output.files_searched),
    files_skipped: finiteNumber(output.files_skipped),
    truncated: output.truncated === true,
    stopped_by: text(output.stopped_by),
    next_action: candidatePaths.length > 0
      ? "Use grep_files with one narrower pattern or read_file on a listed candidate path."
      : "Change one search dimension before trying again; do not repeat the same broad pattern.",
  });
}

function readFilePreview(output: Record<string, unknown>): Record<string, unknown> {
  const content = readFileContentPreview(output);
  return compactUndefined({
    tool_name: "read_file",
    path: text(output.path),
    start_line: finiteNumber(output.start_line),
    end_line: finiteNumber(output.end_line),
    truncated: output.truncated === true,
    content: content.text,
    preview_content_truncated: content.truncated,
    preview_start_line: content.startLine,
    preview_end_line: content.endLine,
    next_start_line: content.nextStartLine,
    omitted_through_line: content.truncated ? finiteNumber(output.end_line) ?? undefined : undefined,
  });
}

function readFileContentPreview(output: Record<string, unknown>): {
  text?: string;
  truncated: boolean;
  startLine?: number;
  endLine?: number;
  nextStartLine?: number;
} {
  const content = text(output.content);
  const startLine = finiteNumber(output.start_line) ?? undefined;
  if (!content) return { truncated: false, startLine };
  if (content.length <= MAX_FILE_CONTENT_CHARS) {
    return {
      text: content,
      truncated: false,
      startLine,
      endLine: finiteNumber(output.end_line) ?? undefined,
    };
  }
  const candidate = content.slice(0, MAX_FILE_CONTENT_CHARS);
  const lineBoundary = candidate.lastIndexOf("\n");
  if (lineBoundary < Math.floor(MAX_FILE_CONTENT_CHARS / 2) || startLine === undefined) {
    return {
      text: `${candidate}...`,
      truncated: true,
      startLine,
    };
  }
  const visible = candidate.slice(0, lineBoundary);
  const visibleLineCount = visible.split("\n").length;
  const endLine = startLine + visibleLineCount - 1;
  const nextStartLine = endLine + 1;
  return {
    text: `${visible}\n[preview cut; continue with read_file start_line=${nextStartLine}]`,
    truncated: true,
    startLine,
    endLine,
    nextStartLine,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toolPayload(
  value: unknown,
  expectedKeys: readonly string[],
  depth = 0,
): Record<string, unknown> | null {
  const valueRecord = record(value);
  if (!valueRecord) return null;
  if (expectedKeys.some((key) => key in valueRecord)) return valueRecord;
  if (depth >= 3) return valueRecord;
  for (const key of ["result", "output"] as const) {
    const nested = record(valueRecord[key]);
    if (!nested) continue;
    const payload = toolPayload(nested, expectedKeys, depth + 1);
    if (payload && expectedKeys.some((expectedKey) => expectedKey in payload)) return payload;
  }
  return valueRecord;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedText(value: unknown, maxChars: number): string | undefined {
  const valueText = text(value);
  if (!valueText) return undefined;
  return valueText.length <= maxChars
    ? valueText
    : `${valueText.slice(0, maxChars)}...`;
}

function boundedHeadTailText(value: unknown, maxChars: number): string | undefined {
  const valueText = text(value);
  if (!valueText) return undefined;
  if (valueText.length <= maxChars) return valueText;
  const marker = "\n...[middle omitted]...\n";
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.floor(available * 0.4);
  return `${valueText.slice(0, headLength)}${marker}${valueText.slice(-(available - headLength))}`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
