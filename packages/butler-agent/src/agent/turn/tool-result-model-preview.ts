const MAX_CANDIDATE_PATHS = 24;
const MAX_MATCH_PREVIEWS = 12;
const MAX_MATCH_TEXT_CHARS = 240;
const MAX_FILE_CONTENT_CHARS = 4_800;

export function structuredToolResultModelPreview(input: {
  toolName: string;
  output: unknown;
}): Record<string, unknown> | null {
  if (input.toolName === "grep_files") {
    const output = toolPayload(input.output, ["matches", "pattern"]);
    return output ? grepFilesPreview(output) : null;
  }
  if (input.toolName === "read_file") {
    const output = toolPayload(input.output, ["content", "path"]);
    return output ? readFilePreview(output) : null;
  }
  return null;
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
  return compactUndefined({
    tool_name: "read_file",
    path: text(output.path),
    start_line: finiteNumber(output.start_line),
    end_line: finiteNumber(output.end_line),
    truncated: output.truncated === true,
    content: boundedText(output.content, MAX_FILE_CONTENT_CHARS),
  });
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

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
