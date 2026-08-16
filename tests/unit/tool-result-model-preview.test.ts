import { expect, test } from "bun:test";
import { structuredToolResultModelPreview } from "../../packages/butler-agent/src/agent/tools/tool-support.ts";

test("grep model preview preserves bounded candidate paths and actionable matches", () => {
  const preview = structuredToolResultModelPreview({
    toolName: "grep_files",
    output: {
      pattern: "prompt_cache_key",
      files_searched: 42,
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
  expect(String(files[0]?.content).length).toBeLessThan(5_000);
});

test("large read previews expose the exact next source line instead of implying the full slice was visible", () => {
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
  expect(file).toMatchObject({
    preview_content_truncated: true,
    preview_start_line: 1,
    omitted_through_line: 300,
  });
  expect(file?.preview_end_line).toBeNumber();
  expect(file?.next_start_line).toBe(Number(file?.preview_end_line) + 1);
  expect(String(file?.content)).toContain(
    `continue with read_file start_line=${String(file?.next_start_line)}`,
  );
  expect(Number(file?.preview_end_line)).toBeLessThan(300);
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
      artifact: { id: "tool-output-1", command: "bun test", raw_tokens: 2_400 },
      stdout: {
        text: "13 pass\n1 fail",
        start_line: 0,
        returned_lines: 2,
        total_lines: 2,
        truncated_by_lines: false,
        truncated_by_tokens: false,
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
    artifact: { id: "tool-output-1", command: "bun test" },
    stdout: { text: "13 pass\n1 fail" },
    stderr: { text: "Expected: angle brackets\nReceived: opening brackets" },
  });
});

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

test("public web previews mechanically omit evidence already shown in the live turn", () => {
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
  expect(repeated?.evidence_item_count).toBe(0);
  expect(repeated?.evidence_items).toEqual([]);
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

  expect(String(preview?.page_excerpt)).not.toContain(middleFact);
  expect(preview?.evidence_items).toEqual([{
    evidence_item_id: "public-web-middle-chunk",
    source_url: "https://example.com/long-report",
    source_identity: "example.com",
    content_kind: "page_chunk",
    bounded_content: middleFact,
    limitations: [],
  }]);
});
