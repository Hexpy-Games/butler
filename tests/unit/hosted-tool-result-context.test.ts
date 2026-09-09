import { expect, test } from "bun:test";
import {
  hostedToolResultContent,
} from "../../packages/butler-agent/src/integrations/providers/shared/hosted-tool-result-context.ts";
import {
  createToolResultModelPreviewContext,
  beginToolResultModelPreviewBatch,
  toolResultPayloadForProvider,
} from "../../packages/butler-agent/src/agent/tools/tool-support.ts";

test("hosted successful results preserve small facts in the shared model projection", () => {
  const logs: string[] = [];
  const payload = { ok: true, output: { text: "EXACT_HOSTED_RESULT", value: 9 } };
  const content = hostedToolResultContent({
    payload,
    toolName: "read_exact",
    toolCallId: "call-exact",
    log: (line) => logs.push(line),
  });

  expect(JSON.parse(content)).toEqual({
    ok: true,
    output: { tool_name: "read_exact", text: "EXACT_HOSTED_RESULT", value: 9 },
  });
  expect(content).not.toContain("completed-tool-evidence");
  expect(content).not.toContain("evidence_packet");
  expect(logs).toEqual(["tool read_exact result projected for model context"]);
});

test("hosted failures remain structured provider-valid observations", () => {
  const payload = {
    ok: false,
    output: {
      observation_kind: "test_failed",
      model_visible_content: "Expected article but received main",
    },
  };
  const content = hostedToolResultContent({
    payload,
    toolName: "run_command",
    toolCallId: "call-failed",
    log: () => {},
  });

  expect(JSON.parse(content)).toEqual({
    ok: false,
    output: {
      tool_name: "run_command",
      observation_kind: "test_failed",
      model_visible_content: "Expected article but received main",
    },
  });
});

test("provider web results share one bounded live-prompt projection", () => {
  const modelPreviewContext = createToolResultModelPreviewContext();
  const payload = {
    ok: true,
    output: {
      ok: true,
      query: "current market",
      provider: "test-search",
      provider_overview: "The same source-backed provider overview.",
      results: [{ raw_result: "must not reach the model" }],
      public_web_evidence_items: [{
        evidence_item_id: "public-web-same-content",
        source_url: "https://example.com/current-market",
        source_identity: "example.com",
        content_kind: "search_snippet",
        bounded_content: "The source reports a current market move.",
        limitations: [],
      }],
      coverage_budget: {
        result_count: 1,
        stop_reason: "provider_results_exhausted",
        next_search_guidance: "Prescriptive runtime guidance must not reach the model.",
      },
    },
  };

  const first = JSON.parse(hostedToolResultContent({
    payload,
    toolName: "web_search",
    modelPreviewContext,
    log: () => {},
  }));
  const repeated = JSON.parse(hostedToolResultContent({
    payload,
    toolName: "web_search",
    modelPreviewContext,
    log: () => {},
  }));
  const withNewEvidence = JSON.parse(hostedToolResultContent({
    payload: {
      ...payload,
      output: {
        ...payload.output,
        public_web_evidence_items: [
          ...payload.output.public_web_evidence_items,
          {
            evidence_item_id: "public-web-new-content",
            source_url: "https://example.com/new-current-market",
            source_identity: "example.com",
            content_kind: "search_snippet",
            bounded_content: "A different source adds a new market fact.",
            limitations: [],
          },
        ],
      },
    },
    toolName: "web_search",
    modelPreviewContext,
    log: () => {},
  }));

  expect(first.output.provider_overview).toBe(
    "The same source-backed provider overview.",
  );
  expect(first.output.evidence_item_count).toBe(1);
  expect(first.output.coverage_budget).toEqual({
    result_count: 1,
    stop_reason: "provider_results_exhausted",
  });
  expect(first.output.results).toBeUndefined();
  expect(repeated.output.provider_overview).toBeUndefined();
  expect(repeated.output.evidence_item_count).toBe(0);
  expect(withNewEvidence.output.provider_overview).toBeUndefined();
  expect(withNewEvidence.output.evidence_item_count).toBe(1);
  expect(withNewEvidence.output.evidence_items[0].evidence_item_id).toBe(
    "public-web-new-content",
  );
});

test("run_work_block projects every nested result through the shared context", () => {
  const modelPreviewContext = createToolResultModelPreviewContext();
  const exactNonWebResult = {
    ok: true,
    output: { text: "EXACT_NESTED_NON_WEB_RESULT", value: 7 },
  };
  const payload = {
    ok: true,
    output: {
      frontier: { pending: 0 },
      results: [{
        name: "read_exact",
        result: exactNonWebResult,
      }, {
        name: "web_search",
        result: {
          ok: true,
          provider_overview: "Nested provider overview.",
          public_web_evidence_items: [{
            evidence_item_id: "nested-public-web-evidence",
            source_url: "https://example.com/nested",
            source_identity: "example.com",
            content_kind: "search_snippet",
            bounded_content: "Nested public evidence.",
            limitations: [],
          }],
        },
      }],
    },
  };

  const projected = toolResultPayloadForProvider(payload, {
    toolName: "run_work_block",
    context: modelPreviewContext,
  });
  const directRepeat = toolResultPayloadForProvider({
    ok: true,
    output: payload.output.results[1]!.result,
  }, {
    toolName: "web_search",
    context: modelPreviewContext,
  });

  expect((projected.output as any).frontier).toEqual({ pending: 0 });
  expect((projected.output as any).results[0]).toMatchObject({
    name: "read_exact",
    preview: {
      tool_name: "read_exact",
      ok: true,
      output: { text: "EXACT_NESTED_NON_WEB_RESULT", value: 7 },
    },
  });
  expect((projected.output as any).results[1]).toMatchObject({
    name: "web_search",
    preview: {
      tool_name: "web_search",
      provider_overview: "Nested provider overview.",
      evidence_item_count: 1,
    },
  });
  expect((directRepeat.output as any).provider_overview).toBeUndefined();
  expect((directRepeat.output as any).evidence_item_count).toBe(0);
});

test("parallel results share the bytes remaining in one model request", () => {
  const context = createToolResultModelPreviewContext();
  beginToolResultModelPreviewBatch(context, { maxBytes: 3_000, resultCount: 2 });
  const first = toolResultPayloadForProvider({
    ok: true,
    output: { text: "A".repeat(20_000), next_cursor: "cursor-a" },
  }, { toolName: "read_exact", context });
  const second = toolResultPayloadForProvider({
    ok: true,
    output: { text: "B".repeat(20_000), artifact_id: "artifact-b" },
  }, { toolName: "read_exact", context });

  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(1_500);
  expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThanOrEqual(1_500);
  expect(JSON.stringify(first)).toContain("cursor-a");
  expect(JSON.stringify(second)).toContain("artifact-b");
});
