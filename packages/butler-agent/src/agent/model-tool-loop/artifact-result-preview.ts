import {
  boundedHeadTailText,
  boundedText,
  compactUndefined,
  finiteNumber,
  record,
  text,
} from "./preview-values.ts";

export function artifactResultPreview(
  toolName: "read_tool_output_artifact" | "read_tool_evidence_artifact",
  output: Record<string, unknown>,
): Record<string, unknown> {
  return toolName === "read_tool_output_artifact"
    ? compactUndefined({
        tool_name: toolName,
        ok: typeof output.ok === "boolean" ? output.ok : undefined,
        artifact: artifactIdentity(output.artifact),
        stdout: artifactSlice(output.stdout, 3_600),
        stderr: artifactSlice(output.stderr, 3_600),
        error: boundedText(output.error, 320),
      })
    : compactUndefined({
        tool_name: toolName,
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

function artifactSlice(
  value: unknown,
  maxChars: number,
): Record<string, unknown> | undefined {
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
