import type { GuidedExactOperationResult } from
  "../../adapters/index.ts";
import type { GuidedOperationResultViewSelector } from
  "../../tools/m1-compact-replay.ts";
import { stableJson } from "../identity/index.ts";
import { tokenBudgetToChars } from "../../context/budget.ts";

export type { GuidedOperationResultViewSelector } from
  "../../tools/m1-compact-replay.ts";

const RESULT_ROOTS = new Set(["request", "result", "record"]);
const MAX_SEARCH_MATCHES = 20;
const MAX_SEARCH_SNIPPET_CHARS = 160;

export type GuidedOperationResultViewSelection = {
  selector: GuidedOperationResultViewSelector;
  view: unknown;
};

export type GuidedOperationResultViewErrorCode =
  | "guided_result_view_pointer_required"
  | "guided_result_view_pointer_invalid"
  | "guided_result_view_pointer_root_invalid"
  | "guided_result_view_pointer_missing"
  | "guided_result_view_capture_incomplete"
  | "guided_result_view_line_range_invalid"
  | "guided_result_view_line_range_out_of_bounds"
  | "guided_result_view_byte_range_invalid"
  | "guided_result_view_byte_range_out_of_bounds"
  | "guided_result_view_byte_range_utf8_boundary"
  | "guided_result_view_search_query_required"
  | "guided_result_view_search_max_matches_invalid"
  | "guided_result_view_search_max_matches_too_large"
  | "guided_result_view_value_not_serializable"
  | "guided_result_view_output_budget_invalid"
  | "guided_result_view_output_budget_exceeded";

export class GuidedOperationResultViewError extends Error {
  constructor(readonly code: GuidedOperationResultViewErrorCode) {
    super(code);
    this.name = "GuidedOperationResultViewError";
  }
}

type GuidedOperationResultDocument = {
  request: unknown;
  result: unknown;
  resultCaptured: boolean;
  record: Omit<GuidedExactOperationResult, "request" | "result">;
};

type SearchMatch = {
  line: number;
  column: number;
  snippet: string;
};

/** Selects one bounded, replayable view from a durable exact result. */
export function selectGuidedOperationResultView(input: {
  result: GuidedExactOperationResult;
  selector: GuidedOperationResultViewSelector;
  maxOutputTokens: number;
}): GuidedOperationResultViewSelection {
  const maxOutputChars = outputBudgetChars(input.maxOutputTokens);
  const document = documentForExactResult(input.result);
  const selected = selectView(document, input.selector);
  assertWithinOutputBudget(selected, maxOutputChars);
  return {
    selector: input.selector,
    view: selected,
  };
}

function documentForExactResult(
  result: GuidedExactOperationResult,
): GuidedOperationResultDocument {
  return {
    request: result.request,
    result: result.result,
    resultCaptured: Object.prototype.hasOwnProperty.call(result, "result"),
    record: {
      resultRef: result.resultRef,
      sequence: result.sequence,
      revision: result.revision,
      sessionId: result.sessionId,
      scope: result.scope,
      toolCallId: result.toolCallId,
      originTurnId: result.originTurnId,
      toolName: result.toolName,
      status: result.status,
      ...(result.resultSha256 ? { resultSha256: result.resultSha256 } : {}),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    },
  };
}

function selectView(
  document: GuidedOperationResultDocument,
  selector: GuidedOperationResultViewSelector,
): unknown {
  const selected = resolvePointer(document, selector.pointer);
  if (selector.kind === "json_pointer") return selected;

  const text = textValue(selected);
  if (selector.kind === "line_range") {
    return selectLineRange(text, selector.start_line, selector.end_line);
  }
  if (selector.kind === "byte_range") {
    return selectByteRange(text, selector.start_byte, selector.end_byte);
  }
  return selectSearch(text, selector.query, selector.max_matches);
}

function resolvePointer(
  document: GuidedOperationResultDocument,
  pointer: string,
): unknown {
  if (typeof pointer !== "string" || pointer.length === 0) {
    throw new GuidedOperationResultViewError(
      "guided_result_view_pointer_required",
    );
  }
  if (!pointer.startsWith("/")) {
    throw new GuidedOperationResultViewError(
      "guided_result_view_pointer_invalid",
    );
  }
  const tokens = pointer.slice(1).split("/").map(decodePointerToken);
  const root = tokens[0];
  if (!root || !RESULT_ROOTS.has(root)) {
    throw new GuidedOperationResultViewError(
      "guided_result_view_pointer_root_invalid",
    );
  }
  if (root === "result" && !document.resultCaptured) {
    throw new GuidedOperationResultViewError(
      "guided_result_view_capture_incomplete",
    );
  }

  let current: unknown = document[root as keyof GuidedOperationResultDocument];
  for (const token of tokens.slice(1)) {
    if (!hasPointerMember(current, token)) {
      throw new GuidedOperationResultViewError(
        "guided_result_view_pointer_missing",
      );
    }
    current = pointerMember(current, token);
  }
  return current;
}

function decodePointerToken(token: string): string {
  let decoded = "";
  for (let index = 0; index < token.length; index += 1) {
    const character = token[index];
    if (character !== "~") {
      decoded += character;
      continue;
    }
    const escape = token[index + 1];
    if (escape !== "0" && escape !== "1") {
      throw new GuidedOperationResultViewError(
        "guided_result_view_pointer_invalid",
      );
    }
    decoded += escape === "0" ? "~" : "/";
    index += 1;
  }
  return decoded;
}

function hasPointerMember(value: unknown, token: string): boolean {
  if (Array.isArray(value)) {
    return /^(?:0|[1-9][0-9]*)$/u.test(token) &&
      Number(token) < value.length;
  }
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, token);
}

function pointerMember(value: unknown, token: string): unknown {
  if (Array.isArray(value)) return value[Number(token)];
  return (value as Record<string, unknown>)[token];
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return stableJson(value);
  } catch {
    throw new GuidedOperationResultViewError(
      "guided_result_view_value_not_serializable",
    );
  }
}

function selectLineRange(
  text: string,
  startLine: number,
  endLine: number,
): string {
  if (!isPositiveInteger(startLine) || !isPositiveInteger(endLine) ||
    endLine < startLine) {
    throw new GuidedOperationResultViewError(
      "guided_result_view_line_range_invalid",
    );
  }
  const lines = text.split("\n");
  if (startLine > lines.length || endLine > lines.length) {
    throw new GuidedOperationResultViewError(
      "guided_result_view_line_range_out_of_bounds",
    );
  }
  return lines.slice(startLine - 1, endLine).join("\n");
}

function selectByteRange(text: string, start: number, end: number): string {
  if (!isNonNegativeInteger(start) || !isNonNegativeInteger(end) || end < start) {
    throw new GuidedOperationResultViewError(
      "guided_result_view_byte_range_invalid",
    );
  }
  const bytes = Buffer.from(text, "utf8");
  if (end > bytes.byteLength) {
    throw new GuidedOperationResultViewError(
      "guided_result_view_byte_range_out_of_bounds",
    );
  }
  if (!isUtf8Boundary(bytes, start) || !isUtf8Boundary(bytes, end)) {
    throw new GuidedOperationResultViewError(
      "guided_result_view_byte_range_utf8_boundary",
    );
  }
  return bytes.subarray(start, end).toString("utf8");
}

function selectSearch(
  text: string,
  query: string,
  maxMatches: number,
): SearchMatch[] {
  if (typeof query !== "string" || query.length === 0) {
    throw new GuidedOperationResultViewError(
      "guided_result_view_search_query_required",
    );
  }
  if (!isPositiveInteger(maxMatches)) {
    throw new GuidedOperationResultViewError(
      "guided_result_view_search_max_matches_invalid",
    );
  }
  if (maxMatches > MAX_SEARCH_MATCHES) {
    throw new GuidedOperationResultViewError(
      "guided_result_view_search_max_matches_too_large",
    );
  }

  const matches: SearchMatch[] = [];
  let offset = 0;
  while (matches.length < maxMatches + 1) {
    const matchOffset = text.indexOf(query, offset);
    if (matchOffset < 0) break;
    matches.push(searchMatch(text, matchOffset, query.length));
    offset = matchOffset + Math.max(1, query.length);
  }
  return matches.slice(0, maxMatches);
}

function searchMatch(text: string, offset: number, queryLength: number): SearchMatch {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const nextLineBreak = text.indexOf("\n", offset);
  const lineEnd = nextLineBreak < 0 ? text.length : nextLineBreak;
  const line = text.slice(lineStart, lineEnd);
  return {
    line: lineNumber(text, lineStart),
    column: Array.from(text.slice(lineStart, offset)).length + 1,
    snippet: boundedSnippet(line, offset - lineStart, queryLength),
  };
}

function lineNumber(text: string, lineStart: number): number {
  let line = 1;
  for (let index = 0; index < lineStart; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

function boundedSnippet(line: string, matchStart: number, matchLength: number): string {
  if (line.length <= MAX_SEARCH_SNIPPET_CHARS) return line;
  const context = Math.floor((MAX_SEARCH_SNIPPET_CHARS - matchLength) / 2);
  let start = Math.max(0, matchStart - context);
  const end = Math.min(line.length, start + MAX_SEARCH_SNIPPET_CHARS);
  if (end - start < MAX_SEARCH_SNIPPET_CHARS) {
    start = Math.max(0, end - MAX_SEARCH_SNIPPET_CHARS);
  }
  const prefix = start > 0 ? "…" : "";
  const suffix = end < line.length ? "…" : "";
  return `${prefix}${line.slice(start, end)}${suffix}`;
}

function assertWithinOutputBudget(value: unknown, maxOutputChars: number): void {
  let encoded: string;
  try {
    encoded = stableJson(value);
  } catch {
    throw new GuidedOperationResultViewError(
      "guided_result_view_value_not_serializable",
    );
  }
  if (encoded.length > maxOutputChars) {
    throw new GuidedOperationResultViewError(
      "guided_result_view_output_budget_exceeded",
    );
  }
}

function outputBudgetChars(maxOutputTokens: number): number {
  if (!isPositiveInteger(maxOutputTokens) ||
    maxOutputTokens > Number.MAX_SAFE_INTEGER / 4) {
    throw new GuidedOperationResultViewError(
      "guided_result_view_output_budget_invalid",
    );
  }
  return tokenBudgetToChars(maxOutputTokens);
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  return offset === 0 || offset === bytes.byteLength ||
    (bytes[offset]! & 0xc0) !== 0x80;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
