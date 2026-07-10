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
