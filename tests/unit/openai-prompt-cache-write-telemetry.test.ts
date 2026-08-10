import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSseResponseFromAccumulator } from
  "../../packages/butler-agent/src/integrations/providers/openai/codex-response-assembly.ts";
import { recordPromptCacheMetric } from
  "../../packages/butler-agent/src/integrations/providers/openai/usage.ts";
import { readPromptCacheMetrics } from
  "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";
import { extractPromptCacheStats } from
  "../../packages/butler-agent/src/integrations/providers/shared/usage.ts";
import type { OpenAIResponse } from
  "../../packages/butler-agent/src/integrations/providers/runtime-contracts.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenAI prompt cache write telemetry", () => {
  test("preserves Codex cache writes through extraction and durable metrics", () => {
    const butlerData = temporaryButlerData();
    const response = codexSseResponseFromAccumulator({
      output: [],
      completed: {
        id: "response-cache-write",
        output: [{ type: "output_text", text: "done" }],
        usage: {
          input_tokens: 2_400,
          total_tokens: 2_520,
          input_tokens_details: {
            cached_tokens: 1_152,
            cache_write_tokens: 1_024,
          },
        },
      },
      fallbackText: "",
      sequence: 0,
      fallbackStreamId: "stream-cache-write",
    });

    expect(extractPromptCacheStats(response)).toEqual({
      promptTokens: 2_400,
      cachedTokens: 1_152,
      providerCacheReadTokens: 1_152,
      cacheWriteTokens: 1_024,
      outputTokens: null,
      totalTokens: 2_520,
    });
    recordPromptCacheMetric(response, {
      model: "gpt-5.6-sol",
      scope: "btcc:task_execution",
      promptCache: { prompt_cache_key: "btcc:task_execution" },
      butlerData,
      usageAttribution: {
        turnId: "turn-cache-write",
        phase: "task_execution",
        reasoningEffort: "low",
      },
    });

    expect(readPromptCacheMetrics({ butlerData })).toEqual([
      expect.objectContaining({
        model: "gpt-5.6-sol",
        scope: "btcc:task_execution",
        turnId: "turn-cache-write",
        phase: "task_execution",
        reasoningEffort: "low",
        promptTokens: 2_400,
        cachedTokens: 1_152,
        cacheWriteTokens: 1_024,
        promptCacheKey: "btcc:task_execution",
      }),
    ]);
    expect(readPromptCacheMetrics({ butlerData })[0]!.roundIndex).toBeUndefined();
  });

  test("keeps older usage payloads valid when cache-write data is absent", () => {
    const response: OpenAIResponse = {
      id: "response-no-cache-write",
      usage: {
        prompt_tokens: 800,
        total_tokens: 850,
        prompt_tokens_details: { cached_tokens: 256 },
      },
    };

    expect(extractPromptCacheStats(response)).toEqual({
      promptTokens: 800,
      cachedTokens: 256,
      providerCacheReadTokens: 256,
      cacheWriteTokens: null,
      outputTokens: null,
      totalTokens: 850,
    });
  });
});

function temporaryButlerData(): string {
  const directory = mkdtempSync(join(tmpdir(), "butler-cache-write-"));
  temporaryDirectories.push(directory);
  return directory;
}
