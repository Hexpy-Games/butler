/** Shared tool support owns bounded, model-safe result previews. */
const MAX_CANDIDATE_PATHS = 24;
const MAX_MATCH_PREVIEWS = 12;
const MAX_MATCH_TEXT_CHARS = 240;
const MAX_FILE_CONTENT_CHARS = 4_800;
const WORK_BLOCK_TOOL_NAME = "run_work_block";
const WORK_RESULT_TOOL_NAMES = new Set([
  "start_work",
  "continue_work",
  "replace_work_plan",
  "record_work_checkpoint",
  "record_work_review",
  "record_work_disposition",
]);

export interface ToolResultModelPreviewContext {
  seenPublicWebEvidenceItemIds: Set<string>;
  seenProviderOverviews: Set<string>;
  resultBatchBudget?: {
    remainingBytes: number;
    remainingResults: number;
  };
}

export type StructuredToolResultModelProjection = {
  preview: Record<string, unknown> | null;
  partial: boolean;
};

export function structuredToolResultModelPreview(input: {
  toolName: string;
  output: unknown;
  seenPublicWebEvidenceItemIds?: Set<string>;
  context?: ToolResultModelPreviewContext;
}): Record<string, unknown> | null {
  return structuredToolResultModelProjection(input).preview;
}

/** Reports semantic projection loss separately from the provider-facing payload. */
export function structuredToolResultModelProjection(input: {
  toolName: string;
  output: unknown;
  seenPublicWebEvidenceItemIds?: Set<string>;
  context?: ToolResultModelPreviewContext;
}): StructuredToolResultModelProjection {
  const preview = buildStructuredToolResultModelPreview(input);
  return {
    preview,
    partial: preview !== null && !previewPreservesOriginalContent(input.output, preview),
  };
}

function buildStructuredToolResultModelPreview(input: {
  toolName: string;
  output: unknown;
  seenPublicWebEvidenceItemIds?: Set<string>;
  context?: ToolResultModelPreviewContext;
}): Record<string, unknown> | null {
  if (input.toolName === WORK_BLOCK_TOOL_NAME) {
    const output = toolPayload(input.output, ["results"]);
    return output ? workBlockPreview(output, input.context) : null;
  }
  if (WORK_RESULT_TOOL_NAMES.has(input.toolName)) {
    const output = toolPayload(input.output, ["work", "error"]);
    return output ? workResultPreview(input.toolName, output) : null;
  }
  if (input.toolName === "grep_files") {
    const output = toolPayload(input.output, ["matches", "pattern"]);
    return output ? grepFilesPreview(output) : null;
  }
  if (input.toolName === "read_file") {
    const output = toolPayload(input.output, ["files"]);
    return output ? readFileBatchPreview(output) : null;
  }
  if (input.toolName === "read_conversation_context") {
    const output = toolPayload(input.output, ["messages", "summaries"]);
    return output ? conversationContextPreview(output) : null;
  }
  if (input.toolName === "read_tool_output_artifact") {
    const output = toolPayload(input.output, ["stdout", "stderr"]);
    return output ? artifactResultPreview(input.toolName, output) : null;
  }
  if (input.toolName === "read_tool_evidence_artifact") {
    const output = toolPayload(input.output, ["text", "artifact"]);
    return output ? artifactResultPreview(input.toolName, output) : null;
  }
  if (input.toolName === "read_operation_results") {
    const output = toolPayload(input.output, ["encoding", "data", "offset"]);
    return output && typeof output.data === "string"
      ? operationResultPagePreview(output)
      : genericToolPreview(input.toolName, input.output);
  }
  if (input.toolName === "run_command") {
    const output = toolPayload(input.output, ["model_visible_content", "exit_code"]);
    return output ? runCommandPreview(output) : null;
  }
  if (input.toolName === "web_search" || input.toolName === "web_read") {
    const output = toolPayload(input.output, ["public_web_evidence_items"]);
    return output
      ? publicWebEvidencePreview(
        input.toolName,
        output,
        input.context?.seenPublicWebEvidenceItemIds ??
          input.seenPublicWebEvidenceItemIds,
        input.context?.seenProviderOverviews,
      )
      : null;
  }
  return genericToolPreview(input.toolName, input.output);
}

function previewPreservesOriginalContent(original: unknown, preview: unknown): boolean {
  if (original === undefined) return true;
  if (original === null || typeof original === "boolean" ||
    typeof original === "number" || typeof original === "string") {
    if (Object.is(original, preview)) return true;
    const previewRecord = record(preview);
    return previewRecord
      ? Object.values(previewRecord).some((value) => Object.is(original, value))
      : false;
  }
  if (Array.isArray(original)) {
    return Array.isArray(preview) && preview.length >= original.length &&
      original.every((value, index) => previewPreservesOriginalContent(value, preview[index]));
  }
  const originalRecord = record(original);
  const previewRecord = record(preview);
  if (!originalRecord || !previewRecord) return false;
  return Object.entries(originalRecord).every(([key, value]) =>
    Object.hasOwn(previewRecord, key) &&
    previewPreservesOriginalContent(value, previewRecord[key]),
  );
}

function publicWebEvidencePreview(
  toolName: string,
  output: Record<string, unknown>,
  seenEvidenceItemIds?: Set<string>,
  seenProviderOverviews?: Set<string>,
): Record<string, unknown> {
  const pageExcerptLimit = Math.max(1_500, Math.min(
    8_000,
    Math.trunc(finiteNumber(output.effective_max_chars) ?? 2_000),
  ));
  const pageExcerpt = toolName === "web_read"
    ? boundedHeadTailText(output.markdown, pageExcerptLimit)
    : undefined;
  let remainingWebReadEvidenceChars = pageExcerpt ? 2_400 : Number.POSITIVE_INFINITY;
  const rawItems = Array.isArray(output.public_web_evidence_items)
    ? output.public_web_evidence_items
    : [];
  const items: Record<string, unknown>[] = [];
  for (const value of rawItems) {
    if (items.length >= 12) break;
    const item = record(value);
    if (!item || typeof item.evidence_item_id !== "string" ||
      typeof item.source_url !== "string") continue;
    if (seenEvidenceItemIds?.has(item.evidence_item_id)) continue;
    seenEvidenceItemIds?.add(item.evidence_item_id);
    const boundedContent = boundedText(item.bounded_content, 1_200);
    const projectedContent = !pageExcerpt || !boundedContent ||
        pageExcerpt.includes(boundedContent)
      ? pageExcerpt ? undefined : boundedContent
      : boundedContent.slice(0, remainingWebReadEvidenceChars);
    remainingWebReadEvidenceChars -= projectedContent?.length ?? 0;
    items.push(compactUndefined({
      evidence_item_id: boundedText(item.evidence_item_id, 120),
      source_url: boundedText(item.source_url, 500),
      source_identity: boundedText(item.source_identity, 160),
      published_at: boundedText(item.published_at, 80),
      content_kind: boundedText(item.content_kind, 80),
      bounded_content: projectedContent || undefined,
      limitations: Array.isArray(item.limitations)
        ? item.limitations.slice(0, 6)
          .map((entry) => boundedText(entry, 320)).filter(Boolean)
        : [],
    }));
  }
  const rawFailedQueries = Array.isArray(output.failed_queries)
    ? output.failed_queries
    : [];
  const failedQueries = rawFailedQueries
    .slice(0, 4).flatMap((value) => {
      const failure = record(value);
      if (!failure) return [];
      const query = boundedText(failure.query, 320);
      const error = boundedText(failure.error, 320);
      return query || error ? [compactUndefined({ query, error })] : [];
    });
  const coverage = record(output.coverage_budget);
  const error = record(output.error);
  const providerOverview = unseenProviderOverview(
    output.provider_overview,
    seenProviderOverviews,
  );
  return compactUndefined({
    tool_name: toolName,
    ok: output.ok !== false,
    query: boundedText(output.query, 500),
    provider: boundedText(output.provider, 120),
    provider_overview: boundedHeadTailText(providerOverview, 1_600),
    requested_url: boundedText(output.requested_url, 500),
    source_url: boundedText(output.source_url, 500),
    title: boundedText(output.title, 320),
    status: finiteNumber(output.status) ?? undefined,
    truncated: typeof output.truncated === "boolean"
      ? output.truncated
      : undefined,
    start_chunk: finiteNumber(output.start_chunk) ?? undefined,
    returned_chunks: finiteNumber(output.returned_chunks) ?? undefined,
    total_chunks: finiteNumber(output.total_chunks) ?? undefined,
    next_start_chunk: output.next_start_chunk === null
      ? null
      : finiteNumber(output.next_start_chunk) ?? undefined,
    effective_max_chars: finiteNumber(output.effective_max_chars) ?? undefined,
    effective_max_chunks: finiteNumber(output.effective_max_chunks) ?? undefined,
    content_has_more: typeof output.content_has_more === "boolean"
      ? output.content_has_more
      : undefined,
    markdown_truncated: typeof output.markdown_truncated === "boolean"
      ? output.markdown_truncated
      : undefined,
    duplicate_observation: typeof output.duplicate_observation === "boolean"
      ? output.duplicate_observation
      : undefined,
    evidence_quality: boundedText(output.evidence_quality, 80),
    page_excerpt: pageExcerpt,
    render_recommended: typeof output.render_recommended === "boolean"
      ? output.render_recommended
      : undefined,
    cache_hit: typeof output.cache_hit === "boolean"
      ? output.cache_hit
      : undefined,
    error: boundedText(output.error, 320) ?? (error
      ? compactUndefined({
        code: boundedText(error.code, 120),
        message: boundedText(error.message, 320),
      })
      : undefined),
    observation_kind: boundedText(output.observation_kind, 120),
    summary: boundedText(output.summary, 480),
    model_visible_content: boundedHeadTailText(
      output.model_visible_content,
      1_200,
    ),
    warnings: boundedStringArray(output.warnings, 6, 320),
    search_warnings: boundedStringArray(output.search_warnings, 4, 320),
    failed_query_count: rawFailedQueries.length > 0
      ? rawFailedQueries.length
      : undefined,
    failed_queries: failedQueries.length > 0 ? failedQueries : undefined,
    evidence_items: items,
    evidence_item_count: items.length,
    evidence_item_total: rawItems.length !== items.length
      ? rawItems.length
      : undefined,
    coverage_budget: coverage
      ? compactUndefined({
        result_count: finiteNumber(coverage.result_count) ?? undefined,
        stop_reason: boundedText(coverage.stop_reason, 120),
      })
      : undefined,
    read_required: typeof output.read_required === "boolean"
      ? output.read_required
      : undefined,
    read_reason: boundedText(output.read_reason, 320),
    recommended_read_urls: boundedStringArray(
      output.recommended_read_urls,
      4,
      500,
    ),
  });
}

function boundedStringArray(
  value: unknown,
  limit: number,
  maxChars: number,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.slice(0, limit)
    .map((entry) => boundedText(entry, maxChars))
    .filter((entry): entry is string => Boolean(entry));
  return items.length > 0 ? items : undefined;
}

function runCommandPreview(output: Record<string, unknown>): Record<string, unknown> {
  const artifact = record(output.butler_tool_artifact);
  return compactUndefined({
    tool_name: "run_command",
    ok: typeof output.ok === "boolean" ? output.ok : undefined,
    exit_code: finiteNumber(output.exit_code) ?? undefined,
    timed_out: typeof output.timed_out === "boolean" ? output.timed_out : undefined,
    observation_kind: text(output.observation_kind),
    summary: boundedText(output.summary, 480),
    // The executor applies the requested output policy; the serializer owns the
    // model-request budget. Formatting must not silently cut either result again.
    model_visible_content: typeof output.model_visible_content === "string" ? output.model_visible_content : undefined,
    stderr: typeof output.stderr === "string" ? output.stderr : undefined,
    stdout: typeof output.stdout === "string" ? output.stdout : undefined,
    butler_tool_artifact: artifact
      ? compactUndefined({
          id: text(artifact.id),
          path: text(artifact.path),
          command: boundedText(artifact.command, 320),
          raw_tokens: finiteNumber(artifact.raw_tokens) ?? undefined,
          compact_tokens: finiteNumber(artifact.compact_tokens) ?? undefined,
        })
      : undefined,
    output_presentation: record(output.output_presentation) ?? undefined,
  });
}

function workResultPreview(
  toolName: string,
  output: Record<string, unknown>,
): Record<string, unknown> {
  const work = record(output.work);
  const error = record(output.error);
  return compactUndefined({
    tool_name: toolName,
    ok: typeof output.ok === "boolean" ? output.ok : undefined,
    status: text(output.status),
    authority_pending: typeof output.authority_pending === "boolean"
      ? output.authority_pending
      : undefined,
    executed: typeof output.executed === "boolean" ? output.executed : undefined,
    not_executed: typeof output.not_executed === "boolean"
      ? output.not_executed
      : undefined,
    pending: typeof output.pending === "boolean" ? output.pending : undefined,
    queued: typeof output.queued === "boolean" ? output.queued : undefined,
    exit_code: finiteNumber(output.exit_code) ?? undefined,
    timed_out: typeof output.timed_out === "boolean" ? output.timed_out : undefined,
    error: error
      ? compactUndefined({
          code: text(error.code),
          message: boundedHeadTailText(error.message, 1_200),
          current_stage: text(error.current_stage),
          requested_action: text(error.requested_action),
          unmet_guard: text(error.unmet_guard),
          next_action: text(error.next_action),
        })
      : boundedHeadTailText(output.error, 1_200),
    work: work
      ? compactUndefined({
          work_id: text(work.work_id),
          status: text(work.status),
          current_stage: work.current_stage === null
            ? null
            : text(work.current_stage),
          execution_mode: work.execution_mode === null
            ? null
            : text(work.execution_mode),
          allowed_next_stages: boundedStringArray(
            work.allowed_next_stages,
            Number.MAX_SAFE_INTEGER,
            120,
          ) ?? [],
          actions: workActions(work.actions),
          unresolved_action_keys: boundedStringArray(
            work.unresolved_action_keys,
            Number.MAX_SAFE_INTEGER,
            256,
          ) ?? [],
          completion_blockers: boundedStringArray(
            work.completion_blockers,
            Number.MAX_SAFE_INTEGER,
            160,
          ) ?? [],
          latest_plan_review: work.latest_plan_review === null
            ? null
            : text(work.latest_plan_review),
          latest_result_review: work.latest_result_review === null
            ? null
            : text(work.latest_result_review),
          latest_completion_validation:
            work.latest_completion_validation === null
              ? null
              : text(work.latest_completion_validation),
          latest_disposition: workDisposition(work.latest_disposition),
        })
      : undefined,
  });
}

function workActions(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const action = record(entry);
    const actionKey = text(action?.action_key);
    const status = text(action?.status);
    return actionKey && status
      ? [{ action_key: actionKey, status }]
      : [];
  });
}

function workDisposition(value: unknown): Record<string, unknown> | undefined {
  const disposition = record(value);
  if (!disposition) return undefined;
  return compactUndefined({
    disposition: text(disposition.disposition),
    summary: boundedHeadTailText(disposition.summary, 480),
    remaining_actions: boundedStringArray(
      disposition.remaining_actions,
      12,
      320,
    ) ?? [],
    next_condition: disposition.next_condition === null
      ? null
      : boundedText(disposition.next_condition, 320),
  });
}

function workBlockPreview(
  output: Record<string, unknown>,
  context?: ToolResultModelPreviewContext,
): Record<string, unknown> {
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
        preview: structuredToolResultModelPreview({
          toolName: name,
          output: nested,
          context,
        }),
        ...(typeof result?.error === "string" ? { error: boundedText(result.error, 320) } : {}),
      }];
    }),
  };
}

function unseenProviderOverview(
  value: unknown,
  seenProviderOverviews?: Set<string>,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (seenProviderOverviews?.has(value)) return undefined;
  seenProviderOverviews?.add(value);
  return value;
}

function genericToolPreview(toolName: string, value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    return {
      tool_name: toolName,
      text: boundedHeadTailText(value, MAX_FILE_CONTENT_CHARS),
    };
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return { tool_name: toolName, value };
  }
  const payload = toolPayload(value, []);
  if (!payload) return null;
  const projected = projectGenericRecord(payload, 0);
  return Object.keys(projected).length > 0
    ? { tool_name: toolName, ...projected }
    : { tool_name: toolName };
}

const GENERIC_HIDDEN_KEYS = new Set([
  "stack",
  "providerData",
  "provider_data",
  "raw_prompt",
  "rawPrompt",
]);

function projectGenericRecord(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth > 3) return {};
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (GENERIC_HIDDEN_KEYS.has(key)) continue;
    const projected = projectGenericValue(item, key, depth + 1);
    if (projected !== undefined) result[key] = projected;
  }
  return result;
}

function projectGenericValue(value: unknown, key: string, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (key === "path") return boundedText(value, 240);
    return boundedHeadTailText(value, MAX_FILE_CONTENT_CHARS);
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

function readFileBatchPreview(output: Record<string, unknown>): Record<string, unknown> {
  const files = Array.isArray(output.files)
    ? output.files.slice(0, 20).flatMap((value) => {
      const file = record(value);
      return file ? [readFilePreview(file)] : [];
    })
    : [];
  return compactUndefined({
    tool_name: "read_file",
    ok: typeof output.ok === "boolean" ? output.ok : undefined,
    files,
    files_requested: finiteNumber(output.files_requested),
    files_read: finiteNumber(output.files_read),
    truncated: output.truncated === true,
    next_cursor: text(output.next_cursor),
  });
}

function readFilePreview(output: Record<string, unknown>): Record<string, unknown> {
  const content = readFileContentPreview(output);
  return compactUndefined({
    ok: typeof output.ok === "boolean" ? output.ok : undefined,
    path: text(output.path),
    error: text(output.error),
    message: boundedText(output.message, 320),
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

function conversationContextPreview(output: Record<string, unknown>): Record<string, unknown> {
  return compactUndefined({
    tool_name: "read_conversation_context",
    ok: typeof output.ok === "boolean" ? output.ok : undefined,
    session_id: output.session_id,
    query: output.query,
    anchor_message_id: output.anchor_message_id,
    anchor_event_id: output.anchor_event_id,
    direction: output.direction,
    returned: output.returned,
    truncated: output.truncated,
    messages: Array.isArray(output.messages) ? output.messages : [],
    summaries: Array.isArray(output.summaries) ? output.summaries : [],
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

import {
  artifactResultPreview,
  operationResultPagePreview,
} from "./artifact-result-preview.ts";
import {
  boundedHeadTailText,
  boundedText,
  compactUndefined,
  finiteNumber,
  record,
  text,
} from "./preview-values.ts";
