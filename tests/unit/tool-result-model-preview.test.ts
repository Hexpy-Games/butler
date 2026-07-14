import { expect, test } from "bun:test";
import { structuredToolResultModelPreview } from "../../packages/butler-agent/src/agent/turn/tool-result-model-preview.ts";

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
      path: "src/a.ts",
      start_line: 10,
      end_line: 20,
      truncated: true,
      content: "x".repeat(6_000),
    },
  });

  expect(preview).toMatchObject({
    tool_name: "read_file",
    path: "src/a.ts",
    start_line: 10,
    end_line: 20,
    truncated: true,
  });
  expect(String(preview?.content).length).toBeLessThan(5_000);
});

test("large read previews expose the exact next source line instead of implying the full slice was visible", () => {
  const content = Array.from({ length: 300 }, (_, index) =>
    `line ${index + 1}: ${"x".repeat(48)}`).join("\n");
  const preview = structuredToolResultModelPreview({
    toolName: "read_file",
    output: {
      path: "src/large.ts",
      start_line: 1,
      end_line: 300,
      truncated: true,
      content,
    },
  });

  expect(preview).toMatchObject({
    preview_content_truncated: true,
    preview_start_line: 1,
    omitted_through_line: 300,
  });
  expect(preview?.preview_end_line).toBeNumber();
  expect(preview?.next_start_line).toBe(Number(preview?.preview_end_line) + 1);
  expect(String(preview?.content)).toContain(
    `continue with read_file start_line=${String(preview?.next_start_line)}`,
  );
  expect(Number(preview?.preview_end_line)).toBeLessThan(300);
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
