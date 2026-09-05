/** Shared tool support owns bounded provider result projections. */
import {
  boundedText,
  compactUndefined,
  finiteNumber,
  record,
  text,
} from "./preview-values.ts";

export function operationResultPagePreview(
  output: Record<string, unknown>,
): Record<string, unknown> {
  return compactUndefined({
    tool_name: "read_operation_results",
    encoding: text(output.encoding),
    data: text(output.data),
    offset: finiteNumber(output.offset) ?? undefined,
    length: finiteNumber(output.length) ?? undefined,
    totalBytes: finiteNumber(output.totalBytes) ?? undefined,
    nextOffset: output.nextOffset === null
      ? null
      : finiteNumber(output.nextOffset) ?? undefined,
    resultSha256: text(output.resultSha256),
    complete: typeof output.complete === "boolean" ? output.complete : undefined,
  });
}

/** Shrink an exact result page by advancing its original byte cursor. */
export function fitExactOperationResultPage(
  payload: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  if (serializedBytes(payload) <= maxBytes) return payload;
  const output = record(payload.output);
  if (!output) return payload;
  const {
    encoding,
    data: rawData,
    length: requestedLength,
    totalBytes,
    resultSha256,
    offset: rawOffset,
  } = output;
  const data = typeof rawData === "string" ? rawData : null;
  const offset = typeof rawOffset === "number" ? rawOffset : null;
  if (!data || offset === null) return payload;
  const base = {
    ok: typeof payload.ok === "boolean" ? payload.ok : undefined,
    output: compactUndefined({
      tool_name: "read_operation_results",
      encoding,
      data: "",
      offset,
      length: 0,
      requested_length: requestedLength,
      totalBytes,
      nextOffset: offset,
      resultSha256,
      complete: false,
    }),
    model_preview: {
      truncated: true,
      completeness: "partial",
      original_provider_bytes: serializedBytes(payload),
    },
  };
  let low = 0;
  let high = Math.floor(data.length / 4);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes(exactPage(base, data.slice(0, middle * 4), offset)) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  // A requested page is already bounded. If its identity alone consumes the
  // smaller preview allowance, let whole-request selection make room for it;
  // returning no data and the same cursor would make the reader unusable.
  return low === 0 ? payload : exactPage(base, data.slice(0, low * 4), offset);
}

function exactPage(
  base: Record<string, unknown>,
  data: string,
  offset: number,
): Record<string, unknown> {
  const visibleBytes = Buffer.from(data, "base64").byteLength;
  const output = record(base.output) ?? {};
  return {
    ...base,
    output: {
      ...output,
      data,
      length: visibleBytes,
      nextOffset: offset + visibleBytes,
    },
  };
}

export function artifactResultPreview(
  toolName: "read_tool_output_artifact" | "read_tool_evidence_artifact",
  output: Record<string, unknown>,
): Record<string, unknown> {
  return toolName === "read_tool_output_artifact"
    ? compactUndefined({
        tool_name: toolName,
        ok: typeof output.ok === "boolean" ? output.ok : undefined,
        artifact: artifactIdentity(output.artifact),
        stdout: artifactSlice(output.stdout),
        stderr: artifactSlice(output.stderr),
        error: boundedText(output.error, 320),
      })
    : compactUndefined({
        tool_name: toolName,
        ok: typeof output.ok === "boolean" ? output.ok : undefined,
        artifact: artifactIdentity(output.artifact),
        text: artifactSlice(output.text),
        error: boundedText(output.error, 320),
      });
}

function artifactIdentity(value: unknown): Record<string, unknown> | undefined {
  const artifact = record(value);
  if (!artifact) return undefined;
  return compactUndefined({
    id: text(artifact.id),
    path: text(artifact.path),
    tool_name: text(artifact.tool_name),
    command: boundedText(artifact.command, 320),
    raw_tokens: finiteNumber(artifact.raw_tokens) ?? undefined,
  });
}

function artifactSlice(
  value: unknown,
): Record<string, unknown> | undefined {
  const slice = record(value);
  if (!slice) return undefined;
  return compactUndefined({
    text: typeof slice.text === "string" ? slice.text : undefined,
    start_line: finiteNumber(slice.start_line) ?? undefined,
    start_char: finiteNumber(slice.start_char) ?? undefined,
    next_offset_chars: slice.next_offset_chars === null
      ? null
      : finiteNumber(slice.next_offset_chars) ?? undefined,
    returned_lines: finiteNumber(slice.returned_lines) ?? undefined,
    total_lines: finiteNumber(slice.total_lines) ?? undefined,
    total_chars: finiteNumber(slice.total_chars) ?? undefined,
    truncated_by_lines: typeof slice.truncated_by_lines === "boolean"
      ? slice.truncated_by_lines
      : undefined,
    truncated_by_tokens: typeof slice.truncated_by_tokens === "boolean"
      ? slice.truncated_by_tokens
      : undefined,
    search: artifactSearch(slice.search),
  });
}

/** A reader cursor must describe the delivered prefix, never an omitted middle. */
export function fitToolArtifactPage(
  payload: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  if (serializedBytes(payload) <= maxBytes) return payload;
  const output = record(payload.output);
  if (!output) return payload;
  const streamKeys = ["stdout", "stderr", "text"].filter((key) =>
    typeof record(output[key])?.text === "string",
  );
  const length = Math.max(0, ...streamKeys.map((key) => String(record(output[key])!.text).length));
  const page = (limit: number) => ({
    ...payload,
    output: {
      ...output,
      ...Object.fromEntries(streamKeys.map((key) => {
        const slice = record(output[key])!;
        const original = String(slice.text);
        if (original.length <= limit) return [key, slice];
        const visible = original.slice(0, limit);
        return [key, {
          ...slice,
          text: visible,
          next_offset_chars: Number(slice.start_char ?? 0) + visible.length,
          returned_lines: visible ? visible.split("\n").length - (visible.endsWith("\n") ? 1 : 0) : 0,
          truncated_by_tokens: true,
        }];
      })),
    },
    model_preview: { truncated: true, completeness: "partial" },
  });
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes(page(middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return low === 0 ? payload : page(low);
}

function artifactSearch(value: unknown): Record<string, unknown> | undefined {
  const search = record(value);
  if (!search) return undefined;
  return compactUndefined({
    query: boundedText(search.query, 320),
    found: typeof search.found === "boolean" ? search.found : undefined,
    match_char: search.match_char === null
      ? null
      : finiteNumber(search.match_char) ?? undefined,
  });
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
