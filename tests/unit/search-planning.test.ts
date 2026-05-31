import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildSmartSearchPlanningInstructions,
  buildSmartSearchPlanningPrompt,
  createSmartSearchPlan,
  readSearchPlanningConfig,
} from "../../packages/butler-agent/src/integrations/search/planning.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-search-planning-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(
    join(tempDir, "butler.config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

test("smart search planning retries once after invalid JSON", async () => {
  let calls = 0;
  const result = await createSmartSearchPlan({
    butlerData: tempDir,
    query: "Find today's AI and gaming news with sources",
    runPrompt: async () => {
      calls += 1;
      if (calls === 1) return "{not json";
      return JSON.stringify({
        mode: "smart",
        depth: "deep",
        originalRequest: "Find today's AI and gaming news with sources",
        intent: "current news briefing with evidence",
        scope: "multi_domain",
        decomposition: [
          {
            id: "ai",
            label: "AI",
            reason: "Separate technical news surface",
            priority: "high",
          },
          {
            id: "gaming",
            label: "Gaming",
            reason: "Separate industry news surface",
            priority: "normal",
          },
        ],
        queries: [
          {
            bucketId: "ai",
            query: "today AI industry news sources",
            purpose: "validation",
            priority: "high",
            expectedSourceType: "news",
          },
          {
            bucketId: "gaming",
            query: "today gaming industry news sources",
            purpose: "validation",
            priority: "normal",
            expectedSourceType: "news",
          },
        ],
        parallelizable: true,
        verificationRequired: true,
      });
    },
  });

  expect(result.attempts).toBe(2);
  expect(result.plan?.depth).toBe("deep");
  expect(result.plan?.verificationRequired).toBe(true);
  expect(result.plan?.queries.map((query) => query.query)).toEqual([
    "today AI industry news sources",
    "today gaming industry news sources",
  ]);
});

test("smart search planning falls back to direct search after two invalid planner responses", async () => {
  let calls = 0;
  const result = await createSmartSearchPlan({
    butlerData: tempDir,
    query: "Verify this release rumor",
    runPrompt: async () => {
      calls += 1;
      return "not json";
    },
  });

  expect(calls).toBe(2);
  expect(result.plan).toBeNull();
  expect(result.usedPlanner).toBe(true);
  expect(result.attempts).toBe(2);
  expect(result.fallbackReason?.length).toBeGreaterThan(0);
});

test("search planning config disables smart mode without calling the planner", async () => {
  writeConfig({
    webSearch: {
      planning: {
        enabled: false,
      },
    },
  });
  const config = readSearchPlanningConfig(tempDir);
  const result = await createSmartSearchPlan({
    butlerData: tempDir,
    query: "latest public data",
    runPrompt: async () => {
      throw new Error("planner should not be called");
    },
  });

  expect(config).toMatchObject({
    enabled: false,
    defaultDepth: "balanced",
  });
  expect(result).toMatchObject({
    plan: null,
    usedPlanner: false,
    attempts: 0,
  });
});

test("smart search planner prompt encodes the target planning quality policies", () => {
  const instructions = buildSmartSearchPlanningInstructions();
  const prompt = buildSmartSearchPlanningPrompt({
    query: "펄어비스 지금 사도 될까? 빠르게 알려줘",
    originalRequest: "펄어비스 지금 사도 될까? 빠르게 알려줘",
    attempt: 1,
    config: {
      enabled: true,
      defaultDepth: "balanced",
      timezone: "Asia/Seoul",
    },
  });
  const combined = `${instructions}\n${prompt}`;

  expect(combined).toContain("broad briefing requests");
  expect(combined).toContain("original user request");
  expect(combined).toContain("retrieval seed");
  expect(combined).toContain("restore those from the original request");
  expect(combined).toContain("smallest useful decomposition");
  expect(combined).toContain("one clear retrieval job");
  expect(combined).toContain("search-engine-native keyword queries");
  expect(combined).toContain("fewest lexical anchors");
  expect(combined).toContain("exact entity names");
  expect(combined).toContain("vague intent words");
  expect(combined).toContain("Use dates only when they improve retrieval");
  expect(combined).toContain("do not invent a generic official-blog");
  expect(combined).toContain("Separate scan, official or primary-source, review");
  expect(combined).toContain("For high-risk verification, keep each query narrow");
  expect(combined).toContain("primary-source, regulatory, official-label");
  expect(combined).toContain("target the issuing organization");
  expect(combined).toContain("do not let the user's language or locale exclude");
  expect(combined).toContain("stable source/page/domain-style anchor");
  expect(combined).toContain("Avoid dynamic map, internal search-result");
  expect(combined).toContain("Do not keep multiple user-named subjects");
  expect(combined).toContain("separate language/source lanes");
  expect(combined).toContain("localized entity names");
  expect(combined).toContain("user's language or localized naming");
  expect(combined).toContain("official, global, or source language");
  expect(combined).toContain("source-seeking overview queries");
  expect(combined).toContain("name an appropriate curated source");
  expect(combined).toContain("infer suitable overview sources");
  expect(combined).toContain("do not hardcode a fixed source list");
  expect(combined).toContain("multiple subjects");
  expect(combined).toContain("depth deep");
  expect(combined).toContain("consequential decision-support");
  expect(combined).toContain("current state");
  expect(combined).toContain("primary-source facts");
  expect(combined).toContain("independent analysis or risk");
  expect(combined).toContain("infer the evidence dimensions");
  expect(combined).toContain("specific subject");
  expect(combined).toContain("avoid verdict-seeking query phrasing");
  expect(combined).toContain("verification depth");
  expect(combined).toContain("Preserve explicit temporal constraints");
  expect(combined).toContain("Avoid fragile or provider-specific search syntax");
  expect(combined).not.toContain("financial or investment");
  expect(combined).not.toContain("medical");
  expect(combined).not.toContain("election");
});

test("smart search planner prompt targets separate localized and global source lanes", async () => {
  let capturedPrompt = "";
  const result = await createSmartSearchPlan({
    butlerData: tempDir,
    query: "젠레스 존 제로 현재 진행중인 이벤트 2026 5월 22 공식 HoYoverse Zenless Zone Zero events",
    originalRequest: "아참 그리고 지금 진행중인 젠레스존제로 이벤트들 확인좀 해줄래?",
    maxResults: 6,
    runPrompt: async ({ prompt }) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        depth: "verification",
        originalRequest: "아참 그리고 지금 진행중인 젠레스존제로 이벤트들 확인좀 해줄래?",
        intent: "current event verification for a localized game request",
        scope: "verification",
        decomposition: [
          {
            id: "localized_sources",
            label: "Localized user-language sources",
            reason: "The user used a localized game name and may need local official or media surfaces.",
            priority: "high",
          },
          {
            id: "global_sources",
            label: "Official/global source-language sources",
            reason: "Official and global sources are likely indexed with the English title.",
            priority: "high",
          },
        ],
        queries: [
          {
            bucketId: "localized_sources",
            query: "젠레스 존 제로 현재 이벤트 2026년 5월 공식",
            purpose: "official",
            priority: "high",
            expectedSourceType: "official",
          },
          {
            bucketId: "localized_sources",
            query: "젠레스 존 제로 이벤트 2026년 5월 HoYoLAB",
            purpose: "validation",
            priority: "normal",
            expectedSourceType: "community",
          },
          {
            bucketId: "global_sources",
            query: "Zenless Zone Zero current events May 2026 official",
            purpose: "official",
            priority: "high",
            expectedSourceType: "official",
          },
          {
            bucketId: "global_sources",
            query: "Zenless Zone Zero events May 2026 Game8 Prydwen",
            purpose: "curation",
            priority: "normal",
            expectedSourceType: "curation",
          },
        ],
        verificationRequired: true,
      });
    },
  });

  expect(capturedPrompt).toContain("Original user request or bounded current-turn context");
  expect(capturedPrompt).toContain("separate query lanes");
  expect(capturedPrompt).toContain("아참 그리고 지금 진행중인 젠레스존제로 이벤트들 확인좀 해줄래?");
  expect(result.plan?.depth).toBe("verification");
  expect(result.plan?.queries.map((query) => query.query)).toEqual([
    "젠레스 존 제로 현재 이벤트 2026년 5월 공식",
    "젠레스 존 제로 이벤트 2026년 5월 HoYoLAB",
    "Zenless Zone Zero current events May 2026 official",
    "Zenless Zone Zero events May 2026 Game8 Prydwen",
  ]);
});

test("smart search planner prompt uses original request before collapsed seed query", async () => {
  let capturedPrompt = "";
  const result = await createSmartSearchPlan({
    butlerData: tempDir,
    query: "2026년 5월 21일 게임 AI 주요 뉴스",
    originalRequest: "오늘 게임이랑 AI 쪽에서 중요한 뉴스 근거 포함해서 정리해줘",
    runPrompt: async ({ prompt }) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        depth: "deep",
        originalRequest: "wrong seed echo should not replace Butler context",
        intent: "evidence-backed multi-subject news briefing",
        scope: "multi_domain",
        decomposition: [
          {
            id: "gaming",
            label: "Gaming",
            reason: "Separate source surface",
            priority: "high",
          },
          {
            id: "ai",
            label: "AI",
            reason: "Separate source surface",
            priority: "high",
          },
        ],
        queries: [
          {
            bucketId: "gaming",
            query: "today gaming industry news",
            purpose: "validation",
            priority: "high",
            expectedSourceType: "news",
          },
          {
            bucketId: "ai",
            query: "today AI industry news",
            purpose: "validation",
            priority: "high",
            expectedSourceType: "news",
          },
        ],
        verificationRequired: true,
      });
    },
  });

  expect(capturedPrompt).toContain("Original user request or bounded current-turn context");
  expect(capturedPrompt).toContain("오늘 게임이랑 AI 쪽에서 중요한 뉴스 근거 포함해서 정리해줘");
  expect(capturedPrompt).toContain("Model-selected web_search query");
  expect(capturedPrompt).toContain("2026년 5월 21일 게임 AI 주요 뉴스");
  expect(result.plan?.originalRequest).toBe("오늘 게임이랑 AI 쪽에서 중요한 뉴스 근거 포함해서 정리해줘");
  expect(result.plan?.scope).toBe("multi_domain");
  expect(result.plan?.depth).toBe("deep");
});

test("smart search planner prompt formats today using the configured timezone", () => {
  const prompt = buildSmartSearchPlanningPrompt({
    query: "오늘 주요 뉴스 알려줘",
    attempt: 1,
    now: new Date("2026-05-21T16:00:00.000Z"),
    config: {
      enabled: true,
      defaultDepth: "balanced",
      timezone: "Asia/Seoul",
    },
  });

  expect(prompt).toContain("\"currentDate\": \"2026-05-22\"");
  expect(prompt).toContain("\"timeZone\": \"Asia/Seoul\"");
  expect(prompt).toContain("\"plannedQueryExecution\": \"parallel\"");
});

test("smart search planning still runs for local or small model names", async () => {
  let calls = 0;
  const result = await createSmartSearchPlan({
    butlerData: tempDir,
    model: "local/small-model",
    query: "Find recent release notes",
    runPrompt: async () => {
      calls += 1;
      return JSON.stringify({
        mode: "smart",
        depth: "balanced",
        originalRequest: "Find recent release notes",
        intent: "release note search",
        scope: "single_topic",
        decomposition: [],
        queries: [
          {
            query: "recent release notes",
            purpose: "scan",
            priority: "normal",
            expectedSourceType: "docs",
          },
        ],
        parallelizable: false,
        verificationRequired: false,
      });
    },
  });

  expect(calls).toBe(1);
  expect(result.plan?.queries[0]?.query).toBe("recent release notes");
  expect(result.plan?.parallelizable).toBe(true);
});

test("smart search planning accepts expected target plans for the three example scenarios", async () => {
  const scenarios = [
    {
      input: "오늘 국내외 주요 이슈 알려줘",
      response: {
        mode: "smart",
        depth: "balanced",
        originalRequest: "오늘 국내외 주요 이슈 알려줘",
        intent: "quick broad news briefing",
        scope: "multi_domain",
        decomposition: [
          {
            id: "domestic",
            label: "Domestic news",
            reason: "Local major issues need local curation",
            priority: "high",
          },
          {
            id: "global",
            label: "International news",
            reason: "Global major issues need wire-service curation",
            priority: "high",
          },
        ],
        queries: [
          {
            bucketId: "domestic",
            query: "오늘 국내 주요 뉴스",
            purpose: "curation",
            priority: "high",
            expectedSourceType: "curation",
          },
          {
            bucketId: "domestic",
            query: "연합뉴스 주요뉴스 오늘",
            purpose: "curation",
            priority: "normal",
            expectedSourceType: "news",
          },
          {
            bucketId: "global",
            query: "Reuters top news today",
            purpose: "curation",
            priority: "high",
            expectedSourceType: "news",
          },
          {
            bucketId: "global",
            query: "AP News world today",
            purpose: "curation",
            priority: "normal",
            expectedSourceType: "news",
          },
        ],
        parallelizable: true,
        verificationRequired: false,
      },
      expectedDepth: "balanced",
      expectedQueryParts: ["국내 주요 뉴스", "Reuters top news"],
      expectedVerification: false,
    },
    {
      input: "오늘 게임이랑 AI 쪽에서 중요한 뉴스 근거 포함해서 정리해줘",
      response: {
        mode: "smart",
        depth: "deep",
        originalRequest: "오늘 게임이랑 AI 쪽에서 중요한 뉴스 근거 포함해서 정리해줘",
        intent: "evidence-backed multi-domain news briefing",
        scope: "multi_domain",
        decomposition: [
          {
            id: "gaming",
            label: "Gaming industry",
            reason: "Gaming news has distinct sources",
            priority: "high",
          },
          {
            id: "ai",
            label: "AI industry",
            reason: "AI news has distinct policy and company sources",
            priority: "high",
          },
        ],
        queries: [
          {
            bucketId: "gaming",
            query: "오늘 게임업계 주요 뉴스",
            purpose: "scan",
            priority: "high",
            expectedSourceType: "news",
          },
          {
            bucketId: "gaming",
            query: "today gaming industry news",
            purpose: "validation",
            priority: "normal",
            expectedSourceType: "news",
          },
          {
            bucketId: "ai",
            query: "today AI industry news",
            purpose: "validation",
            priority: "high",
            expectedSourceType: "news",
          },
          {
            bucketId: "ai",
            query: "today artificial intelligence policy company news",
            purpose: "validation",
            priority: "normal",
            expectedSourceType: "news",
          },
        ],
        parallelizable: true,
        verificationRequired: true,
      },
      expectedDepth: "deep",
      expectedQueryParts: ["게임업계", "AI industry"],
      expectedVerification: true,
    },
    {
      input: "펄어비스 지금 사도 될까? 빠르게 알려줘",
      response: {
        mode: "smart",
        depth: "verification",
        originalRequest: "펄어비스 지금 사도 될까? 빠르게 알려줘",
        intent: "financial investment decision support with verification",
        scope: "verification",
        decomposition: [
          {
            id: "market",
            label: "Current market data",
            reason: "Investment questions require current price context",
            priority: "high",
          },
          {
            id: "fundamentals",
            label: "Filings earnings catalysts analyst coverage",
            reason: "Official and market context should be separated",
            priority: "high",
          },
        ],
        queries: [
          {
            bucketId: "market",
            query: "펄어비스 주가 현재",
            purpose: "validation",
            priority: "high",
            expectedSourceType: "news",
          },
          {
            bucketId: "fundamentals",
            query: "펄어비스 최근 실적 공시",
            purpose: "official",
            priority: "high",
            expectedSourceType: "official",
          },
          {
            bucketId: "fundamentals",
            query: "펄어비스 실적 발표 2026",
            purpose: "official",
            priority: "normal",
            expectedSourceType: "official",
          },
          {
            bucketId: "fundamentals",
            query: "펄어비스 신작 출시 일정 붉은사막",
            purpose: "validation",
            priority: "normal",
            expectedSourceType: "news",
          },
          {
            bucketId: "fundamentals",
            query: "펄어비스 증권사 리포트 목표주가",
            purpose: "comparison",
            priority: "normal",
            expectedSourceType: "news",
          },
        ],
        parallelizable: true,
        verificationRequired: true,
      },
      expectedDepth: "verification",
      expectedQueryParts: ["주가 현재", "최근 실적 공시", "증권사 리포트"],
      expectedVerification: true,
    },
  ] as const;

  for (const scenario of scenarios) {
    const result = await createSmartSearchPlan({
      butlerData: tempDir,
      query: scenario.input,
      runPrompt: async () => JSON.stringify(scenario.response),
    });
    const queries = result.plan?.queries.map((query) => query.query).join("\n") ?? "";

    expect(result.plan?.depth).toBe(scenario.expectedDepth);
    expect(result.plan?.verificationRequired).toBe(scenario.expectedVerification);
    expect(result.plan?.parallelizable).toBe(true);
    for (const part of scenario.expectedQueryParts) {
      expect(queries).toContain(part);
    }
  }
});
