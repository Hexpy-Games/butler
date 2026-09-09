import { estimateContextTokens } from "./budget.ts";

export type ToolArtifactTextSlice = {
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
};

/** Shared by both existing artifact readers; offsets preserve exact UTF-16 text. */
export function sliceToolArtifactText(input: {
  text: string;
  offsetLines: number;
  offsetChars?: number;
  search?: string;
  limitLines: number;
  maxTokens: number;
}): ToolArtifactTextSlice {
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
  let low = start;
  let high = lineEnd;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateContextTokens(input.text.slice(start, middle)) <= input.maxTokens) low = middle;
    else high = middle - 1;
  }
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
