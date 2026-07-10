import { expect, test } from "bun:test";
import { buildTurnContinuationEvidence } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-continuation-evidence.ts";

test("search results hand exact candidates to a fresh read decision", () => {
  const evidence = buildTurnContinuationEvidence({
    audit: [{
      name: "grep_files",
      args: { pattern: "prompt_cache" },
      ok: true,
      result: {
        ok: true,
        pattern: "prompt_cache",
        matches: [
          {
            path: "packages/butler-agent/src/integrations/providers/provider.ts",
            line: 710,
            text: "const retention = resolveConfiguredPromptCacheRetention();",
          },
          {
            path: "packages/butler-agent/src/integrations/providers/provider.ts",
            line: 717,
            text: "config.prompt_cache_retention = retention;",
          },
          {
            path: "tests/unit/provider.test.ts",
            line: 90,
            text: "expect(prompt_cache).toBe(true)",
          },
        ],
        truncated: false,
      },
    }],
    publicDecisions: [{
      decisionId: "decision-1",
      semanticBlockId: "contract-1:block:1",
      summary: "캐시 설정 후보를 검색합니다.",
      rationale: "실제 구현 파일을 찾기 위해서입니다.",
      nextStep: "후보 파일을 읽어 설정 함수를 확인합니다.",
      evidenceRefs: [],
      source: "assistant-authored",
    }],
  });

  expect(evidence.modelVisibleContent).toContain("butler.turn-continuation-evidence.v1");
  expect(evidence.modelVisibleContent).toContain('"tool": "read_file"');
  expect(evidence.modelVisibleContent).toContain("packages/butler-agent/src/integrations/providers/provider.ts");
  expect(evidence.modelVisibleContent).toContain("config.prompt_cache_retention = retention;");
  expect(evidence.modelVisibleContent).toContain("후보 파일을 읽어 설정 함수를 확인합니다.");
  expect(evidence.refs).toEqual([
    {
      kind: "source_candidate",
      id: "candidate-1:line-710",
      path: "packages/butler-agent/src/integrations/providers/provider.ts",
    },
    {
      kind: "source_candidate",
      id: "candidate-2:line-717",
      path: "packages/butler-agent/src/integrations/providers/provider.ts",
    },
    {
      kind: "source_candidate",
      id: "candidate-3:line-90",
      path: "tests/unit/provider.test.ts",
    },
  ]);
});

test("repeated grep rounds keep distinct evidence in one bounded frontier", () => {
  const evidence = buildTurnContinuationEvidence({
    audit: [1, 2].map((line) => ({
      name: "grep_files",
      args: { pattern: "cache_key" },
      ok: true,
      result: {
        pattern: "cache_key",
        matches: [{
          path: "packages/butler-agent/src/integrations/providers/provider.ts",
          line,
          text: "cache key",
        }],
      },
    })),
    publicDecisions: [],
  });

  expect(evidence.modelVisibleContent.match(/"result_fingerprint":/g)).toHaveLength(2);
  expect(evidence.refs).toEqual([
    {
      kind: "source_candidate",
      id: "candidate-1:line-1",
      path: "packages/butler-agent/src/integrations/providers/provider.ts",
    },
    {
      kind: "source_candidate",
      id: "candidate-2:line-2",
      path: "packages/butler-agent/src/integrations/providers/provider.ts",
    },
  ]);
});

test("a later verified read advances the frontier to synthesis", () => {
  const evidence = buildTurnContinuationEvidence({
    audit: [
      {
        name: "grep_files",
        args: { pattern: "prompt_cache" },
        ok: true,
        result: {
          pattern: "prompt_cache",
          matches: [{ path: "src/provider.ts", line: 12, text: "prompt_cache" }],
        },
      },
      {
        name: "read_file",
        args: { path: "src/provider.ts" },
        ok: true,
        result: {
          path: "src/provider.ts",
          start_line: 1,
          end_line: 30,
          content: "export function promptCacheConfig() {}",
          truncated: false,
        },
      },
    ],
    publicDecisions: [],
  });

  expect(evidence.modelVisibleContent).toContain('"tool": null');
  expect(evidence.modelVisibleContent).toContain("promptCacheConfig");
  expect(evidence.modelVisibleContent).toContain("A source file has already been read after candidate discovery.");
});
