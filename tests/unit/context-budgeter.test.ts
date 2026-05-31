import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  evaluateContextBudget,
  evaluateWorkingContextBudget,
  estimateContextTokens,
  takeLinesFromEndWithinBudget,
  trimTextToTokenBudget,
} from "../../packages/butler-agent/src/agent/context/budget.ts";

test("context budgeter classifies 70 80 90 percent pressure thresholds", () => {
  const overrides = {
    contextWindowTokens: 1_000,
    reservedOutputTokens: 100,
    reservedToolTokens: 50,
  };

  expect(evaluateContextBudget({
    modelRef: "openai/test",
    inputTokens: 699,
    overrides,
  }).thresholdState).toBe("normal");
  expect(evaluateContextBudget({
    modelRef: "openai/test",
    inputTokens: 700,
    overrides,
  })).toMatchObject({
    thresholdState: "warning",
    pressureLevel: "medium",
    freeTokensAfterReserve: 150,
  });
  expect(evaluateContextBudget({
    modelRef: "openai/test",
    inputTokens: 800,
    overrides,
  })).toMatchObject({
    thresholdState: "auto_compact",
    pressureLevel: "high",
    freeTokensAfterReserve: 50,
  });
  expect(evaluateContextBudget({
    modelRef: "openai/test",
    inputTokens: 900,
    overrides,
  })).toMatchObject({
    thresholdState: "hard_pressure",
    freeTokensAfterReserve: 0,
  });
});

test("context budgeter supports model-specific configured windows", () => {
  const evaluated = evaluateContextBudget({
    modelRef: "openai/custom-large",
    inputTokens: 10_000,
    overrides: {
      modelWindows: {
        "openai/custom-large": 50_000,
      },
    },
  });

  expect(evaluated.contextWindowTokens).toBe(50_000);
  expect(evaluated.usedRatio).toBeCloseTo(0.2, 3);
});

test("context budgeter resolves registered local model windows", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-context-budget-local-"));
  const previousData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
  try {
    writeFileSync(join(tempDir, "butler.config.json"), JSON.stringify({
      models: {
        local: [{
          provider_id: "local",
          provider_label: "Local",
          model_id: "gemma-local-test",
          model_ref: "local/gemma-local-test",
          display_name: "gemma local test",
          api_type: "openai_compatible",
          platform: "llama_cpp",
          server_url: "http://127.0.0.1:8080",
          api_base_url: "http://127.0.0.1:8080/v1",
          context_window_tokens: 32768,
          max_output_tokens: 4096,
          token_estimator: "character_estimate",
          source: "manual",
          source_url: "local-test",
          runtime_supported: true,
          created_at: "2026-05-20T00:00:00.000Z",
          updated_at: "2026-05-20T00:00:00.000Z",
        }],
      },
    }), "utf8");

    const evaluated = evaluateContextBudget({
      modelRef: "local/gemma-local-test",
      inputTokens: 33_000,
    });

    expect(evaluated).toMatchObject({
      providerId: "local",
      modelId: "gemma-local-test",
      contextWindowTokens: 32768,
      tokenEstimator: "character_estimate",
      shouldAutoCompact: true,
      shouldHardPressure: true,
    });
  } finally {
    if (previousData === undefined) delete process.env.BUTLER_DATA;
    else process.env.BUTLER_DATA = previousData;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("working context budget reserves static live runtime and compaction space for local 32k models", () => {
  const evaluated = evaluateWorkingContextBudget({
    modelRef: "local/gemma-4-26b-a4b",
    workingContextTokens: 12_900,
    staticContextTokens: 3_000,
    liveConfigurationTokens: 4_000,
    runtimeStateTokens: 2_000,
    compactionPromptReserveTokens: 2_000,
    overrides: {
      contextWindowTokens: 32_768,
      reservedOutputTokens: 4_096,
      reservedToolTokens: 4_096,
    },
  });

  expect(evaluated.availableWorkingContextTokens).toBe(13_576);
  expect(evaluated.usableUserMessageTokens).toBe(13_576);
  expect(evaluated.usedWorkingRatio).toBeCloseTo(0.950, 3);
  expect(evaluated.shouldAutoCompact).toBe(true);
  expect(evaluated.shouldHardPressure).toBe(false);
});

test("working context budget scales reserves for 33k local models instead of fixed large-model reserves", () => {
  const evaluated = evaluateWorkingContextBudget({
    modelRef: "local/gemma-4-26B-A4B-it-UD-Q4_K_M.gguf",
    workingContextTokens: 22_281,
    overrides: {
      contextWindowTokens: 32_768,
    },
  });

  expect(evaluated.reservedOutputTokens).toBe(4_096);
  expect(evaluated.reservedToolTokens).toBe(3_277);
  expect(evaluated.compactionPromptReserveTokens).toBe(1_638);
  expect(evaluated.availableWorkingContextTokens).toBe(23_757);
  expect(evaluated.usedWorkingRatio).toBeCloseTo(0.938, 3);
  expect(evaluated.shouldAutoCompact).toBe(false);

  const aboveThreshold = evaluateWorkingContextBudget({
    modelRef: "local/gemma-4-26B-A4B-it-UD-Q4_K_M.gguf",
    workingContextTokens: 22_400,
    overrides: {
      contextWindowTokens: 32_768,
    },
  });
  expect(aboveThreshold.shouldAutoCompact).toBe(true);
});

test("budget helpers trim and preserve latest lines within a token budget", () => {
  const lines = [
    `old ${"a".repeat(400)}`,
    `middle ${"b".repeat(400)}`,
    `latest ${"c".repeat(400)}`,
  ];
  const selected = takeLinesFromEndWithinBudget(lines, 130);

  expect(selected).toEqual([lines[2]]);
  expect(estimateContextTokens(selected.join("\n"))).toBeLessThanOrEqual(130);

  const trimmed = trimTextToTokenBudget("x".repeat(2_000), 100);
  expect(trimmed).toContain("trimmed for context budget");
  expect(estimateContextTokens(trimmed)).toBeLessThanOrEqual(100);
});

test("budget helpers keep a bounded slice of an oversized prior line after newer context", () => {
  const oversizedPrior = `prior document ${"attached ".repeat(1_000)}target-source`;
  const selected = takeLinesFromEndWithinBudget([
    oversizedPrior,
    "newer answer",
    "latest question",
  ], 180);

  expect(selected).toHaveLength(3);
  expect(selected[0]).toContain("trimmed for context budget");
  expect(selected[0]).toContain("target-source");
  expect(selected[1]).toBe("newer answer");
  expect(selected[2]).toBe("latest question");
  expect(estimateContextTokens(selected.join("\n"))).toBeLessThanOrEqual(180);
});
