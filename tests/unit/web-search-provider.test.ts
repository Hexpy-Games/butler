import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BraveWebSearchProvider,
  CodexSubscriptionWebSearchProvider,
  createConfiguredWebSearchProvider,
  DuckDuckGoHtmlSearchProvider,
  MockWebSearchProvider,
  OpenAIWebSearchProvider,
  TavilyWebSearchProvider,
} from "../../packages/butler-agent/src/integrations/search/provider.ts";
import { writeButlerOpenAIAuthProfile } from "../../packages/butler-agent/src/integrations/providers/openai/auth.ts";

let tempDir = "";
let originalFetch: typeof globalThis.fetch;
let originalOpenAiKey: string | undefined;
let originalButlerData: string | undefined;

function stubFetch(fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof globalThis.fetch {
  return Object.assign(fn, {
    preconnect: originalFetch.preconnect,
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-web-search-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
  originalFetch = globalThis.fetch;
  originalOpenAiKey = process.env.OPENAI_API_KEY;
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
  delete process.env.OPENAI_API_KEY;
  delete process.env.BUTLER_CODEX_AUTH_PROFILE;
  delete process.env.BUTLER_OPENAI_AUTH_PROFILE;
  delete process.env.CODEX_AUTH_JSON;
  process.env.CODEX_HOME = join(tempDir, "empty-codex-home");
  delete process.env.BUTLER_CODEX_BASE_URL;
  delete process.env.BUTLER_CODEX_USER_AGENT;
  delete process.env.BUTLER_CODEX_OAUTH_ORIGINATOR;
  delete process.env.BUTLER_OPENAI_OAUTH_ORIGINATOR;
  delete process.env.BUTLER_WEB_SEARCH_PROVIDER;
  delete process.env.BUTLER_BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BUTLER_TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

function duckDuckGoFixture(): string {
  return `
    <html>
      <body>
        <div class="result">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fweather.example.com%2Fchungju&amp;rut=abc">
            충주시 오늘 날씨
          </a>
          <a class="result__snippet">충주시 오늘 기온과 강수 예보입니다.</a>
        </div>
        <div class="result">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example.com%2Fworld&amp;rut=def">
            세계 정세 주요 뉴스
          </a>
          <a class="result__snippet">오늘 있었던 국제 이슈 요약입니다.</a>
        </div>
      </body>
    </html>
  `;
}

test("mock web search provider filters and normalizes source domains", async () => {
  const provider = new MockWebSearchProvider([
    {
      title: "Allowed",
      url: "https://docs.example.com/a",
      snippet: "Allowed result",
      source: "",
    },
    {
      title: "Blocked",
      url: "https://noise.example.org/b",
      snippet: "Blocked result",
      source: "noise.example.org",
    },
  ]);

  const output = await provider.search({
    query: "domain filter",
    allowed_domains: ["example.com"],
    max_results: 5,
  });

  expect(output.provider).toBe("mock");
  expect(output.results).toEqual([{
    title: "Allowed",
    url: "https://docs.example.com/a",
    snippet: "Allowed result",
    source: "docs.example.com",
  }]);
});

test("DuckDuckGo HTML provider parses no-key search results", async () => {
  const requests: string[] = [];
  globalThis.fetch = stubFetch(async (url) => {
    requests.push(String(url));
    return new Response(duckDuckGoFixture(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
  const provider = new DuckDuckGoHtmlSearchProvider();

  const output = await provider.search({
    query: "오늘 충주 날씨",
    allowed_domains: ["example.com"],
    max_results: 1,
  });

  expect(requests[0]).toContain("html.duckduckgo.com/html/");
  expect(output.provider).toBe("duckduckgo-html");
  expect(output.results).toEqual([{
    title: "충주시 오늘 날씨",
    url: "https://weather.example.com/chungju",
    snippet: "충주시 오늘 기온과 강수 예보입니다.",
    source: "weather.example.com",
  }]);
});

test("configured provider defaults to DuckDuckGo no-key search", async () => {
  globalThis.fetch = stubFetch(async () => new Response(duckDuckGoFixture()));
  const provider = createConfiguredWebSearchProvider({ butlerData: tempDir });
  const output = await provider.search({ query: "latest news" });

  expect(output.provider).toBe("duckduckgo-html");
  expect(output.results[0]?.url).toBe("https://weather.example.com/chungju");
});

test("configured provider keeps explicit disabled mode", async () => {
  writeFileSync(join(tempDir, "butler.config.json"), `${JSON.stringify({
    webSearch: {
      provider: "disabled",
    },
  })}\n`, "utf8");

  const provider = createConfiguredWebSearchProvider({ butlerData: tempDir });

  await expect(provider.search({ query: "latest news" })).rejects.toThrow("not configured");
});

test("OpenAI web search provider sends Responses API web_search requests and extracts sources", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = stubFetch(async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({
      output: [
        {
          type: "web_search_call",
          action: {
            sources: [
              {
                title: "OpenAI Web Search",
                url: "https://platform.openai.com/docs/guides/tools-web-search",
                snippet: "Official web search guide.",
              },
              {
                title: "Filtered",
                url: "https://blocked.example.com/result",
                snippet: "Should be filtered.",
              },
            ],
          },
        },
        {
          type: "message",
          content: [{
            text: "Use cited sources.",
            annotations: [{
              type: "url_citation",
              title: "Responses",
              url: "https://platform.openai.com/docs/api-reference/responses",
            }],
          }],
        },
      ],
    }), { status: 200 });
  });
  const provider = new OpenAIWebSearchProvider({
    apiKey: "test-key",
    model: "gpt-5",
    apiBase: "https://api.test.openai.local",
  });

  const output = await provider.search({
    query: "OpenAI web search docs",
    allowed_domains: ["platform.openai.com"],
    blocked_domains: undefined,
    max_results: 5,
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://api.test.openai.local/v1/responses");
  expect(requests[0]?.init.headers).toMatchObject({
    "Content-Type": "application/json",
    Authorization: "Bearer test-key",
  });
  expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
    model: "gpt-5",
    tools: [{
      type: "web_search",
      filters: {
        allowed_domains: ["platform.openai.com"],
      },
    }],
    tool_choice: "auto",
    include: ["web_search_call.action.sources"],
    input: "OpenAI web search docs",
  });
  expect(output).toMatchObject({
    query: "OpenAI web search docs",
    provider: "openai-web-search",
    usage: {
      search_requests: 1,
    },
  });
  expect(output.results.map((result) => result.url)).toEqual([
    "https://platform.openai.com/docs/guides/tools-web-search",
    "https://blocked.example.com/result",
    "https://platform.openai.com/docs/api-reference/responses",
  ]);
});

test("OpenAI web search provider reports API errors", async () => {
  globalThis.fetch = stubFetch(async () => new Response(JSON.stringify({
    error: {
      message: "rate limited",
    },
  }), { status: 429 }));
  const provider = new OpenAIWebSearchProvider({
    apiKey: "test-key",
  });

  await expect(provider.search({ query: "anything" })).rejects.toThrow("rate limited");
});

test("Brave web search provider is independent from model provider auth", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = stubFetch(async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({
      web: {
        results: [{
          title: "Brave Result",
          url: "https://news.example.com/article",
          description: "Current result from Brave.",
          age: "2026-04-26",
        }],
      },
    });
  });
  const provider = new BraveWebSearchProvider({
    apiKey: "brave-key",
    apiBase: "https://brave.example/search",
  });

  const output = await provider.search({
    query: "current news",
    max_results: 2,
    allowed_domains: ["example.com"],
  });

  expect(requests).toHaveLength(1);
  expect(String(requests[0]?.url)).toContain("https://brave.example/search?q=current+news");
  expect(new Headers(requests[0]?.init?.headers).get("x-subscription-token")).toBe("brave-key");
  expect(output.provider).toBe("brave");
  expect(output.results).toEqual([{
    title: "Brave Result",
    url: "https://news.example.com/article",
    snippet: "Current result from Brave.",
    source: "news.example.com",
    published_at: "2026-04-26",
  }]);
});

test("Tavily web search provider is independent from model provider auth", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = stubFetch(async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({
      results: [{
        title: "Tavily Result",
        url: "https://docs.example.com/current",
        content: "Current result from Tavily.",
        published_date: "2026-04-26",
      }],
    });
  });
  const provider = new TavilyWebSearchProvider({
    apiKey: "tavily-key",
    apiBase: "https://tavily.example/search",
  });

  const output = await provider.search({
    query: "current docs",
    max_results: 4,
    blocked_domains: ["blocked.example.com"],
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://tavily.example/search");
  expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer tavily-key");
  expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
    query: "current docs",
    max_results: 4,
    exclude_domains: ["blocked.example.com"],
  });
  expect(output.provider).toBe("tavily");
  expect(output.results[0]?.url).toBe("https://docs.example.com/current");
});

test("auto web search prefers dedicated search providers over model-provider search", async () => {
  process.env.BUTLER_WEB_SEARCH_PROVIDER = "auto";
  process.env.BUTLER_BRAVE_SEARCH_API_KEY = "brave-key";
  const requests: string[] = [];
  globalThis.fetch = stubFetch(async (url) => {
    requests.push(String(url));
    return Response.json({
      web: {
        results: [{
          title: "Dedicated Search",
          url: "https://search.example.com/result",
          description: "Dedicated provider result.",
        }],
      },
    });
  });

  const provider = createConfiguredWebSearchProvider({ butlerData: tempDir });
  const output = await provider.search({ query: "provider agnostic search" });

  expect(output.provider).toBe("brave");
  expect(requests[0]).toContain("api.search.brave.com");
});

test("explicit key-based provider falls back to DuckDuckGo when API auth fails", async () => {
  process.env.BUTLER_BRAVE_SEARCH_API_KEY = "bad-brave-key";
  writeFileSync(join(tempDir, "butler.config.json"), `${JSON.stringify({
    webSearch: {
      provider: "brave",
    },
  })}\n`, "utf8");
  const requests: string[] = [];
  globalThis.fetch = stubFetch(async (url) => {
    requests.push(String(url));
    if (String(url).includes("api.search.brave.com")) {
      return Response.json({
        error: { message: "invalid API key" },
      }, { status: 401 });
    }
    return new Response(duckDuckGoFixture(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });

  const provider = createConfiguredWebSearchProvider({ butlerData: tempDir });
  const output = await provider.search({ query: "오늘 충주 날씨" });

  expect(requests.some((url) => url.includes("api.search.brave.com"))).toBe(true);
  expect(requests.some((url) => url.includes("html.duckduckgo.com"))).toBe(true);
  expect(output.provider).toBe("duckduckgo-html");
  expect(output.results[0]?.source).toBe("weather.example.com");
});

test("key-based provider fallback does not hide validation errors", async () => {
  process.env.BUTLER_BRAVE_SEARCH_API_KEY = "brave-key";
  writeFileSync(join(tempDir, "butler.config.json"), `${JSON.stringify({
    webSearch: {
      provider: "brave",
    },
  })}\n`, "utf8");
  let fetchCalls = 0;
  globalThis.fetch = stubFetch(async () => {
    fetchCalls += 1;
    return new Response(duckDuckGoFixture());
  });

  const provider = createConfiguredWebSearchProvider({ butlerData: tempDir });

  await expect(provider.search({
    query: "invalid filters",
    allowed_domains: ["example.com"],
    blocked_domains: ["blocked.example.com"],
  })).rejects.toThrow("allowed_domains and blocked_domains cannot both be set");
  expect(fetchCalls).toBe(0);
});

test("DuckDuckGo HTML provider times out stalled requests", async () => {
  globalThis.fetch = stubFetch(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  const provider = new DuckDuckGoHtmlSearchProvider({ timeoutMs: 5 });

  await expect(provider.search({ query: "stalled search" })).rejects.toThrow("web search request timed out");
});

test("Codex subscription web search provider uses Codex backend and extracts source URLs", async () => {
  const token = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "chatgpt-account",
    },
  });
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = stubFetch(async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response([
      'data: {"type":"response.output_item.done","item":{"type":"web_search_call","status":"completed","action":{"type":"search","query":"weather"}}}',
      "",
      'data: {"type":"response.output_text.delta","delta":"현재 기온 11도. 출처: https://weather.example.com/seoul"}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), { status: 200 });
  });
  const provider = new CodexSubscriptionWebSearchProvider({
    authorization: `Bearer ${token}`,
    model: "gpt-5.5-codex",
    apiBase: "https://chatgpt.example/backend-api",
  });

  const output = await provider.search({ query: "서울 현재 날씨", max_results: 3 });

  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://chatgpt.example/backend-api/codex/responses");
  const headers = new Headers(requests[0]?.init.headers);
  expect(headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(headers.get("chatgpt-account-id")).toBe("chatgpt-account");
  expect(headers.get("openai-beta")).toBe("responses=experimental");
  expect(headers.get("originator")).toBe("butler");
  expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
    model: "gpt-5.5",
    stream: true,
    store: false,
    tools: [{ type: "web_search" }],
  });
  expect(output.provider).toBe("codex-subscription-web-search");
  expect(output.results.map((result) => result.url)).toEqual(["https://weather.example.com/seoul"]);
});

test("auto web search uses Codex subscription auth profile when API key is absent", async () => {
  process.env.BUTLER_WEB_SEARCH_PROVIDER = "auto";
  writeFileSync(join(tempDir, "butler.config.json"), `${JSON.stringify({
    webSearch: {
      model: "test-codex-web-search-model",
    },
  })}\n`, "utf8");
  const token = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "chatgpt-account",
    },
  });
  writeButlerOpenAIAuthProfile({
    provider: "openai-codex",
    type: "oauth",
    accessToken: token,
    provenance: "codex-subscription-oauth",
    updatedAt: new Date(0).toISOString(),
  });
  process.env.BUTLER_CODEX_BASE_URL = "https://chatgpt.example/backend-api";
  globalThis.fetch = stubFetch(async () => new Response([
    'data: {"type":"response.output_text.delta","delta":"출처: https://example.com/result"}',
    "",
    "data: [DONE]",
    "",
  ].join("\n"), { status: 200 }));

  const provider = createConfiguredWebSearchProvider({ butlerData: tempDir });
  const output = await provider.search({ query: "current docs" });

  expect(output.provider).toBe("codex-subscription-web-search");
  expect(output.results[0]?.url).toBe("https://example.com/result");
});
