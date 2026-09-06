import { expect, test } from "bun:test";
import {
  beginToolResultModelPreviewBatch,
  createToolResultModelPreviewContext,
  structuredToolResultModelPreview,
  toolResultPayloadForProvider,
} from "../../packages/butler-agent/src/agent/tools/tool-support.ts";

test("grep model preview preserves bounded candidate paths and actionable matches", () => {
  const preview = structuredToolResultModelPreview({
    toolName: "grep_files",
    output: {
      pattern: "prompt_cache_key",
      files_searched: 42,
      evidence_receipts: [{ internal: true }],
      evidence_capability_receipts: [{ internal: true }],
      metrics: { elapsed_ms: 5 },
      next_cursor: "next-page",
      matches: [
        { path: "packages/butler-agent/src/integrations/providers/provider.ts", line: 713, text: "prompt_cache_key: key" },
        { path: "tests/unit/openai-auth-models.test.ts", line: 401, text: "expect(prompt_cache_key)" },
      ],
      truncated: true,
      stopped_by: "max_matches",
    },
  });

  expect(preview).toMatchObject({
    tool_name: "grep_files",
    pattern: "prompt_cache_key",
    match_count: 2,
    next_cursor: "next-page",
    candidate_paths: [
      "packages/butler-agent/src/integrations/providers/provider.ts",
      "tests/unit/openai-auth-models.test.ts",
    ],
    matches: [
      {
        path: "packages/butler-agent/src/integrations/providers/provider.ts",
        line: 713,
        text: "prompt_cache_key: key",
      },
      {
        path: "tests/unit/openai-auth-models.test.ts",
        line: 401,
        text: "expect(prompt_cache_key)",
      },
    ],
    truncated: true,
    stopped_by: "max_matches",
  });
  expect(preview).not.toHaveProperty("evidence_receipts");
  expect(preview).not.toHaveProperty("evidence_capability_receipts");
  expect(preview).not.toHaveProperty("metrics");
});

test("grep model preview unwraps audited executor result envelopes", () => {
  const preview = structuredToolResultModelPreview({
    toolName: "grep_files",
    output: {
      ok: true,
      result: {
        pattern: "retention",
        matches: [{
          path: "packages/butler-agent/src/integrations/providers/provider.ts",
          line: 716,
          text: "prompt_cache_retention: retention",
        }],
      },
    },
  });

  expect(preview).toMatchObject({
    pattern: "retention",
    match_count: 1,
    candidate_paths: ["packages/butler-agent/src/integrations/providers/provider.ts"],
  });
});

test("read file model preview keeps location and bounded content", () => {
  const preview = structuredToolResultModelPreview({
    toolName: "read_file",
    output: {
      ok: true,
      files_requested: 1,
      files_read: 1,
      truncated: true,
      files: [{
        ok: true,
        path: "src/a.ts",
        start_line: 10,
        end_line: 20,
        truncated: true,
        content: "x".repeat(6_000),
      }],
    },
  });

  expect(preview).toMatchObject({
    tool_name: "read_file",
    ok: true,
    files: [{
      path: "src/a.ts",
      start_line: 10,
      end_line: 20,
      truncated: true,
    }],
    truncated: true,
  });
  const files = preview?.files as Array<Record<string, unknown>>;
  expect(files[0]?.content).toBe("x".repeat(6_000));
});

test("read formatting preserves the complete requested source slice before budget fitting", () => {
  const content = Array.from({ length: 300 }, (_, index) =>
    `line ${index + 1}: ${"x".repeat(48)}`).join("\n");
  const preview = structuredToolResultModelPreview({
    toolName: "read_file",
    output: {
      ok: true,
      files_requested: 1,
      files_read: 1,
      truncated: true,
      files: [{
        ok: true,
        path: "src/large.ts",
        start_line: 1,
        end_line: 300,
        truncated: true,
        content,
      }],
    },
  });

  const file = (preview?.files as Array<Record<string, unknown>>)[0];
  expect(file).toMatchObject({ content, start_line: 1, end_line: 300, truncated: true });
  expect(file?.preview_content_truncated).toBeUndefined();
});

test("bounded conversation context remains a complete provider-safe observation", () => {
  const messages = [{
    conversation_message_id: "message-1",
    turn_id: "turn-1",
    seq: 4,
    created_at: "2026-07-13T00:00:00.000Z",
    speaker: "user",
    role: "user",
    text: `배포 서버는 ${[192, 168, 1, 18].join(".")}이야.`,
    parts: [],
  }];
  const summaries = [{
    summary_id: "summary-1",
    covers_from_seq: 1,
    covers_to_seq: 3,
    source_hash: "source-hash",
    text: "이전 배포는 전용 SSH 키를 사용했다.",
  }];
  const preview = structuredToolResultModelPreview({
    toolName: "read_conversation_context",
    output: {
      ok: true,
      session_id: "conversation-session-1",
      runtime_session_id: "private-runtime-session",
      query: "배포 서버",
      anchor_message_id: null,
      anchor_event_id: null,
      direction: "around",
      returned: 1,
      truncated: false,
      messages,
      summaries,
    },
  });

  expect(preview).toEqual({
    tool_name: "read_conversation_context",
    ok: true,
    session_id: "conversation-session-1",
    query: "배포 서버",
    anchor_message_id: null,
    anchor_event_id: null,
    direction: "around",
    returned: 1,
    truncated: false,
    messages,
    summaries,
  });
  expect(JSON.stringify(preview)).not.toContain("private-runtime-session");
});

test("tool output artifact previews preserve the rehydrated error text", () => {
  const preview = structuredToolResultModelPreview({
    toolName: "read_tool_output_artifact",
    output: {
      ok: true,
      artifact: {
        id: "tool-output-1",
        path: "/private/butler/tool-output-1.json",
        command: "bun test",
        raw_tokens: 2_400,
      },
      stdout: {
        text: "13 pass\n1 fail",
        start_line: 0,
        start_char: 0,
        next_offset_chars: 14,
        returned_lines: 2,
        total_lines: 2,
        truncated_by_lines: false,
        truncated_by_tokens: false,
        search: { query: "fail", found: true, match_char: 8 },
      },
      stderr: {
        text: "Expected: angle brackets\nReceived: opening brackets",
        start_line: 0,
        returned_lines: 2,
        total_lines: 2,
        truncated_by_lines: false,
        truncated_by_tokens: false,
      },
    },
  });

  expect(preview).toMatchObject({
    tool_name: "read_tool_output_artifact",
    artifact: {
      id: "tool-output-1",
      path: "/private/butler/tool-output-1.json",
      command: "bun test",
    },
    stdout: {
      text: "13 pass\n1 fail",
      start_char: 0,
      next_offset_chars: 14,
      search: { query: "fail", found: true, match_char: 8 },
    },
    stderr: { text: "Expected: angle brackets\nReceived: opening brackets" },
  });
});

test("large Work results keep current stage and every action status before generic fitting", () => {
  const actions = Array.from({ length: 20 }, (_, index) => ({
    action_key: `action-${index + 1}`,
    status: index === 19 ? "active" : "done",
    ignored_description: "not part of the current control projection".repeat(100),
  }));
  const preview = structuredToolResultModelPreview({
    toolName: "record_work_checkpoint",
    output: {
      ok: true,
      work: {
        work_id: "work-current",
        status: "open",
        current_stage: "execution",
        execution_mode: "workers",
        allowed_next_stages: ["review"],
        actions,
        unresolved_action_keys: ["action-20"],
        completion_blockers: ["unresolved_actions"],
      },
    },
  });

  expect(preview).toMatchObject({
    tool_name: "record_work_checkpoint",
    ok: true,
    work: {
      work_id: "work-current",
      status: "open",
      current_stage: "execution",
      execution_mode: "workers",
      unresolved_action_keys: ["action-20"],
    },
  });
  expect((preview?.work as { actions: unknown[] }).actions).toHaveLength(20);
  expect((preview?.work as { actions: unknown[] }).actions.at(-1)).toEqual({
    action_key: "action-20",
    status: "active",
  });
});

test("a fitted failure preview keeps truthful Work facts and callable exact-read arguments", () => {
  const context = createToolResultModelPreviewContext();
  beginToolResultModelPreviewBatch(context, { maxBytes: 1_800, resultCount: 1 });
  const exactReadReference = {
    capability: "read_operation_results" as const,
    arguments: {
      result_ref: "result-current",
      sha256: "a".repeat(64),
      revision: 7,
      work_id: "work-current",
      offset: 0,
      length: 4_096,
    },
    total_bytes: 90_000,
  };
  const projected = toolResultPayloadForProvider({
    ok: false,
    error: "Tool execution failed after durable completion details were recorded.",
    output: {
      ok: false,
      status: "awaiting_allow",
      authority_pending: true,
      executed: false,
      error: {
        code: "completion_gate_failed",
        message: `The completion review still requires one action. ${"M".repeat(10_000)}`,
        current_stage: "validation",
        requested_action: "record_work_disposition",
        unmet_guard: "unresolved_actions",
        next_action: "record_work_checkpoint",
      },
      work: {
        work_id: "work-current",
        status: "open",
        current_stage: "validation",
        execution_mode: "workers",
        actions: [
          { action_key: "implement", status: "done" },
          { action_key: "validate", status: "active" },
        ],
        unresolved_action_keys: ["validate"],
        completion_blockers: ["unresolved_actions"],
        large_detail: "D".repeat(80_000),
      },
    },
  }, {
    toolName: "record_work_disposition",
    context,
    exactReadReference,
  });

  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(1_800);
  expect(projected).toMatchObject({
    ok: false,
    output: {
      ok: false,
      status: "awaiting_allow",
      authority_pending: true,
      executed: false,
      error: {
        code: "completion_gate_failed",
        current_stage: "validation",
        requested_action: "record_work_disposition",
        unmet_guard: "unresolved_actions",
        next_action: "record_work_checkpoint",
      },
      work: {
        work_id: "work-current",
        status: "open",
        current_stage: "validation",
        execution_mode: "workers",
        actions: [
          { action_key: "implement", status: "done" },
          { action_key: "validate", status: "active" },
        ],
      },
    },
    model_preview: {
      truncated: true,
      completeness: "partial",
      exact_read: exactReadReference,
    },
  });
  expect(JSON.stringify(projected)).not.toContain("Use the result's cursor");
});

test("small generic arrays are complete without requiring a re-read", () => {
  const exactReadReference = exactReadReferenceFor("generic-result");
  const projected = toolResultPayloadForProvider({
    ok: true,
    output: { items: Array.from({ length: 13 }, (_, index) => ({ index })) },
  }, { toolName: "unknown_tool", exactReadReference });

  expect((projected.output as { items: unknown[] }).items).toHaveLength(13);
  expect(projected.model_preview).toBeUndefined();
});

test("small search batches retain all matches and text", () => {
  const exactReadReference = exactReadReferenceFor("grep-result");
  const projected = toolResultPayloadForProvider({
    ok: true,
    output: {
      pattern: "needle",
      matches: Array.from({ length: 13 }, (_, index) => ({
        path: `file-${index}.ts`,
        line: index + 1,
        text: `needle-${index}-${"detail".repeat(80)}`,
      })),
    },
  }, { toolName: "grep_files", exactReadReference });

  expect((projected.output as { matches: unknown[] }).matches).toHaveLength(13);
  expect(projected.model_preview).toBeUndefined();
});

test("semantic omission never invents an exact-read reference", () => {
  const projected = toolResultPayloadForProvider({
    ok: true,
    output: { items: Array.from({ length: 13 }, (_, index) => ({ index })) },
  }, { toolName: "unknown_tool" });

  expect((projected.output as { items: unknown[] }).items).toHaveLength(13);
  expect(projected.model_preview).toBeUndefined();
});

test("an exact operation-result page fits by advancing the original byte cursor", () => {
  const context = createToolResultModelPreviewContext();
  beginToolResultModelPreviewBatch(context, { maxBytes: 512, resultCount: 1 });
  const data = Buffer.from("R".repeat(4_096)).toString("base64");
  const projected = toolResultPayloadForProvider({
    ok: true,
    output: {
      encoding: "base64",
      data,
      offset: 0,
      length: 4_096,
      totalBytes: 8_192,
      nextOffset: 4_096,
      resultSha256: "b".repeat(64),
      complete: false,
    },
  }, { toolName: "read_operation_results", context });

  const output = projected.output as {
    data: string;
    offset: number;
    length: number;
    requested_length: number;
    nextOffset: number;
  };
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(512);
  expect(output.data.length).toBeLessThan(data.length);
  expect(output.offset).toBe(0);
  expect(output.requested_length).toBe(4_096);
  expect(output.length).toBeGreaterThan(0);
  expect(output.length).toBe(Buffer.from(output.data, "base64").byteLength);
  expect(output.nextOffset).toBe(output.length);
  expect(projected).toMatchObject({
    model_preview: { truncated: true, completeness: "partial" },
  });
  expect(JSON.stringify(projected)).not.toContain("exact_read");
});

function exactReadReferenceFor(resultRef: string) {
  return {
    capability: "read_operation_results" as const,
    arguments: {
      result_ref: resultRef,
      sha256: "c".repeat(64),
      revision: 1,
      work_id: null,
      offset: 0,
      length: 4_096,
    },
    total_bytes: 8_192,
  };
}

test("tool evidence artifact previews preserve the requested bounded text slice", () => {
  const preview = structuredToolResultModelPreview({
    toolName: "read_tool_evidence_artifact",
    output: {
      ok: true,
      artifact: { id: "evidence-1", tool_name: "read_file", raw_tokens: 1_900 },
      text: {
        text: "line 120: exact source evidence",
        start_line: 119,
        returned_lines: 1,
        total_lines: 300,
        truncated_by_lines: true,
        truncated_by_tokens: false,
      },
    },
  });

  expect(preview).toMatchObject({
    tool_name: "read_tool_evidence_artifact",
    artifact: { id: "evidence-1", tool_name: "read_file" },
    text: {
      text: "line 120: exact source evidence",
      start_line: 119,
      truncated_by_lines: true,
    },
  });
});

test("public web previews retain bounded evidence IDs and source content for restart", () => {
  const preview = structuredToolResultModelPreview({
    toolName: "web_search",
    output: {
      ok: true,
      public_web_evidence_items: [{
        evidence_item_id: "public-web-evidence-1",
        source_url: "https://news.example/event",
        source_identity: "news.example",
        published_at: "2026-07-12",
        content_kind: "search_snippet",
        bounded_content: "The event happened on July 12.",
        limitations: ["Search excerpt."],
      }],
    },
  });

  expect(preview).toEqual({
    tool_name: "web_search",
    ok: true,
    evidence_item_count: 1,
    evidence_items: [{
      evidence_item_id: "public-web-evidence-1",
      source_url: "https://news.example/event",
      source_identity: "news.example",
      published_at: "2026-07-12",
      content_kind: "search_snippet",
      bounded_content: "The event happened on July 12.",
      limitations: ["Search excerpt."],
    }],
  });
});

test("public web previews retain factual search coverage without prescribing the next search", () => {
  const preview = structuredToolResultModelPreview({
    toolName: "web_search",
    output: {
      ok: true,
      query: "market research",
      provider: "duckduckgo-html",
      provider_overview: "Three sources report improving market breadth.",
      public_web_evidence_items: [],
      search_warnings: [
        "1 of 4 planned web searches failed; successful results were preserved.",
      ],
      failed_queries: [{
        query: "KOSPI latest flow",
        error: "anti-bot challenge",
      }],
      coverage_budget: {
        result_count: 3,
        stop_reason: "provider_results_exhausted",
        next_search_guidance: "Search only for a missing outcome.",
      },
      read_required: true,
      read_reason: "Verify source-backed claims.",
      recommended_read_urls: ["https://example.com/source"],
    },
  });

  expect(preview).toMatchObject({
    query: "market research",
    provider: "duckduckgo-html",
    provider_overview: "Three sources report improving market breadth.",
    search_warnings: [
      "1 of 4 planned web searches failed; successful results were preserved.",
    ],
    failed_query_count: 1,
    failed_queries: [{
      query: "KOSPI latest flow",
      error: "anti-bot challenge",
    }],
    coverage_budget: {
      result_count: 3,
      stop_reason: "provider_results_exhausted",
    },
    read_required: true,
    recommended_read_urls: ["https://example.com/source"],
  });
  expect(preview?.coverage_budget).not.toHaveProperty("next_search_guidance");
});

test("repeated public web reads return their content even after earlier context eviction", () => {
  const seenPublicWebEvidenceItemIds = new Set<string>();
  const output = {
    ok: true,
    public_web_evidence_items: [{
      evidence_item_id: "same-content-id",
      source_url: "https://example.com/fact",
      source_identity: "example.com",
      content_kind: "search_snippet",
      bounded_content: "One factual observation.",
      limitations: [],
    }],
  };

  const first = structuredToolResultModelPreview({
    toolName: "web_search",
    output,
    seenPublicWebEvidenceItemIds,
  });
  const repeated = structuredToolResultModelPreview({
    toolName: "web_search",
    output,
    seenPublicWebEvidenceItemIds,
  });

  expect(first?.evidence_item_count).toBe(1);
  expect(repeated).toEqual(first);
});

test("public web previews retain resolved ordinary tool errors", () => {
  const preview = structuredToolResultModelPreview({
    toolName: "web_search",
    output: {
      ok: false,
      error: {
        code: "web_search_provider_error",
        message: "Search provider was blocked by an anti-bot challenge.",
        internal_detail: "must not enter the model context",
      },
      public_web_evidence_items: [],
    },
  });

  expect(preview).toEqual({
    tool_name: "web_search",
    ok: false,
    error: {
      code: "web_search_provider_error",
      message: "Search provider was blocked by an anti-bot challenge.",
    },
    evidence_items: [],
    evidence_item_count: 0,
  });
});

test("web read previews retain the default bounded page body", () => {
  const pageBody = `${"first-section ".repeat(80)}LATE_PAGE_FACT${
    " final-section".repeat(35)
  }`;
  const preview = structuredToolResultModelPreview({
    toolName: "web_read",
    output: {
      ok: true,
      requested_url: "https://example.com/report",
      source_url: "https://example.com/report",
      markdown: pageBody,
      start_chunk: 1,
      returned_chunks: 2,
      total_chunks: 5,
      next_start_chunk: 3,
      effective_max_chars: 2_000,
      effective_max_chunks: 2,
      content_has_more: true,
      markdown_truncated: false,
      duplicate_observation: false,
      public_web_evidence_items: [{
        evidence_item_id: "public-web-short-chunk",
        source_url: "https://example.com/report",
        source_identity: "example.com",
        content_kind: "page_chunk",
        bounded_content: pageBody.slice(0, 320),
        limitations: [],
      }],
    },
  });

  expect(preview?.page_excerpt).toContain("LATE_PAGE_FACT");
  expect(preview).toMatchObject({
    start_chunk: 1,
    returned_chunks: 2,
    total_chunks: 5,
    next_start_chunk: 3,
    effective_max_chars: 2_000,
    effective_max_chunks: 2,
    content_has_more: true,
    markdown_truncated: false,
    duplicate_observation: false,
  });
  expect(String(preview?.page_excerpt).length).toBeLessThanOrEqual(2_000);
  expect(preview?.evidence_items).toEqual([{
    evidence_item_id: "public-web-short-chunk",
    source_url: "https://example.com/report",
    source_identity: "example.com",
    content_kind: "page_chunk",
    bounded_content: pageBody.slice(0, 320),
    limitations: [],
  }]);
  expect(JSON.stringify(preview).match(/LATE_PAGE_FACT/g)?.length).toBe(1);
});

test("web read previews expose the complete max_chars chunk window before advancing", () => {
  const pageBody = `${"A".repeat(1_500)}${"B".repeat(1_500)}MIDDLE_WINDOW_FACT${
    "C".repeat(1_500)
  }`;
  const preview = structuredToolResultModelPreview({
    toolName: "web_read",
    output: {
      ok: true,
      source_url: "https://example.com/complete-window",
      markdown: pageBody,
      effective_max_chars: 5_000,
      returned_chunks: 3,
      total_chunks: 4,
      next_start_chunk: 3,
      content_has_more: true,
      public_web_evidence_items: [],
    },
  });

  expect(preview?.page_excerpt).toBe(pageBody);
  expect(preview?.page_excerpt).toContain("MIDDLE_WINDOW_FACT");
});

test("web read previews keep bounded evidence content when no page body is available", () => {
  const preview = structuredToolResultModelPreview({
    toolName: "web_read",
    output: {
      ok: true,
      source_url: "https://example.com/report",
      public_web_evidence_items: [{
        evidence_item_id: "public-web-fallback-chunk",
        source_url: "https://example.com/report",
        source_identity: "example.com",
        content_kind: "page_chunk",
        bounded_content: "Fallback source fact.",
        limitations: [],
      }],
    },
  });

  expect(preview).not.toHaveProperty("page_excerpt");
  expect(preview?.evidence_items).toEqual([{
    evidence_item_id: "public-web-fallback-chunk",
    source_url: "https://example.com/report",
    source_identity: "example.com",
    content_kind: "page_chunk",
    bounded_content: "Fallback source fact.",
    limitations: [],
  }]);
});

test("web read previews keep evidence chunks that are outside the page excerpt", () => {
  const middleFact = "MIDDLE_ONLY_FACT: operating margin improved by 4.2 percentage points.";
  const pageBody = `${"opening context ".repeat(180)}${middleFact}${
    " closing context".repeat(180)
  }`;
  const preview = structuredToolResultModelPreview({
    toolName: "web_read",
    output: {
      ok: true,
      source_url: "https://example.com/long-report",
      markdown: pageBody,
      public_web_evidence_items: [{
        evidence_item_id: "public-web-middle-chunk",
        source_url: "https://example.com/long-report",
        source_identity: "example.com",
        content_kind: "page_chunk",
        bounded_content: middleFact,
        limitations: [],
      }],
    },
  });

  expect(String(preview?.page_excerpt)).toContain(middleFact);
  expect(preview?.evidence_items).toEqual([{
    evidence_item_id: "public-web-middle-chunk",
    source_url: "https://example.com/long-report",
    source_identity: "example.com",
    content_kind: "page_chunk",
    bounded_content: middleFact,
    limitations: [],
  }]);
});
