import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createButlerToolExecutor } from
  "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import type { SmartSearchPlanningResult } from
  "../../packages/butler-agent/src/integrations/search/planning.ts";
import {
  FallbackWebSearchProvider,
  readWebSearchMetrics,
  type WebSearchProvider,
} from "../../packages/butler-agent/src/integrations/search/provider.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `butler-web-search-resilience-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function plannerFor(queries: string[]) {
  return async (): Promise<SmartSearchPlanningResult> => ({
    usedPlanner: true,
    attempts: 1,
    plan: {
      mode: "smart",
      depth: "deep",
      originalRequest: "Research current markets from several sources.",
      intent: "current multi-source research",
      scope: "comparison",
      decomposition: [],
      queries: queries.map((query) => ({
        query,
        purpose: "validation",
        priority: "high",
        expectedSourceType: "news",
      })),
      parallelizable: true,
      verificationRequired: true,
    },
  });
}

function successfulResult(query: string, provider: string) {
  return {
    query,
    results: [{
      title: `Result for ${query}`,
      url: `https://example.com/${query}`,
      snippet: "source evidence",
      source: "example.com",
    }],
    duration_ms: 1,
    provider,
    usage: { search_requests: 1 },
  };
}

test("planned DuckDuckGo search limits bursts and preserves partial successes", async () => {
  let active = 0;
  let maxActive = 0;
  const provider: WebSearchProvider = {
    id: "duckduckgo-html",
    async search(input) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await Bun.sleep(10);
        if (input.query === "market-2") {
          throw new Error("anti-bot challenge");
        }
        return successfulResult(input.query, "duckduckgo-html");
      } finally {
        active -= 1;
      }
    },
  };
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    webSearchProvider: provider,
    searchPlanner: plannerFor([
      "market-1",
      "market-2",
      "market-3",
      "market-4",
    ]),
  });

  const result = await execute({
    name: "web_search",
    args: { query: "current market research", max_results: 4 },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(maxActive).toBe(2);
  expect(result.source_urls).toEqual([
    "https://example.com/market-1",
    "https://example.com/market-3",
    "https://example.com/market-4",
  ]);
  expect(result.search_warnings).toEqual([
    "1 of 4 planned web searches failed; successful results were preserved.",
  ]);
  expect(result.failed_queries).toEqual([{
    query: "market-2",
    error: "anti-bot challenge",
  }]);
  expect(result.usage.search_requests).toBe(4);
  expect(readWebSearchMetrics(tempDir).lastError).toBeNull();
});

test("planned fallback search inherits the DuckDuckGo concurrency limit", async () => {
  let active = 0;
  let maxActive = 0;
  const primary: WebSearchProvider = {
    id: "primary",
    async search() {
      throw new Error("primary unavailable");
    },
  };
  const fallback: WebSearchProvider = {
    id: "duckduckgo-html",
    plannedSearchConcurrency: 2,
    async search(input) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await Bun.sleep(10);
        return successfulResult(input.query, "duckduckgo-html");
      } finally {
        active -= 1;
      }
    },
  };
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    webSearchProvider: new FallbackWebSearchProvider(primary, fallback),
    searchPlanner: plannerFor([
      "fallback-1",
      "fallback-2",
      "fallback-3",
      "fallback-4",
    ]),
  });

  const result = await execute({
    name: "web_search",
    args: { query: "fallback source research", max_results: 4 },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(maxActive).toBe(2);
  expect(result.source_urls).toHaveLength(4);
});

test("planned searches keep normal parallelism for non-DuckDuckGo providers", async () => {
  let active = 0;
  let maxActive = 0;
  const provider: WebSearchProvider = {
    id: "tracking",
    async search(input) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await Bun.sleep(10);
        return successfulResult(input.query, "tracking");
      } finally {
        active -= 1;
      }
    },
  };
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    webSearchProvider: provider,
    searchPlanner: plannerFor([
      "source-1",
      "source-2",
      "source-3",
      "source-4",
    ]),
  });

  const result = await execute({
    name: "web_search",
    args: { query: "parallel source research", max_results: 4 },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(maxActive).toBe(4);
  expect(result.source_urls).toHaveLength(4);
  expect(result.search_warnings).toBeUndefined();
  expect(result.failed_queries).toBeUndefined();
});

test("planned search reports an ordinary error when every query fails", async () => {
  const provider: WebSearchProvider = {
    id: "duckduckgo-html",
    async search(input) {
      throw new Error(`blocked ${input.query}`);
    },
  };
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    webSearchProvider: provider,
    searchPlanner: plannerFor(["market-1", "market-2", "market-3"]),
  });

  await expect(execute({
    name: "web_search",
    args: { query: "blocked market research", max_results: 3 },
    rawArguments: "{}",
  })).rejects.toThrow(
    "All 3 planned web searches failed via duckduckgo-html: blocked market-1",
  );
  expect(readWebSearchMetrics(tempDir).lastError).toContain(
    "All 3 planned web searches failed via duckduckgo-html",
  );
});

test("planned DuckDuckGo search does not start another batch after cancellation", async () => {
  const controller = new AbortController();
  const searched: string[] = [];
  const provider: WebSearchProvider = {
    id: "duckduckgo-html",
    async search(input) {
      searched.push(input.query);
      if (searched.length === 2) {
        controller.abort(Object.assign(new Error("cancelled"), {
          name: "AbortError",
        }));
      }
      return successfulResult(input.query, "duckduckgo-html");
    },
  };
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    webSearchProvider: provider,
    searchPlanner: plannerFor([
      "market-1",
      "market-2",
      "market-3",
      "market-4",
    ]),
  });

  await expect(execute({
    name: "web_search",
    args: { query: "cancelled market research", max_results: 4 },
    rawArguments: "{}",
    signal: controller.signal,
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(searched).toEqual(["market-1", "market-2"]);
});
