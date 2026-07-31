import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { arch, platform, release } from "os";
import { join } from "path";
import { JSDOM } from "jsdom";
import { accountIdFromAccessToken, resolveOpenAIAuth } from "../providers/openai/auth.ts";

export interface WebSearchInput {
  query: string;
  signal?: AbortSignal;
  allowed_domains?: string[];
  blocked_domains?: string[];
  recency_days?: number;
  max_results?: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  published_at?: string;
}

export interface WebSearchOutput {
  query: string;
  results: WebSearchResult[];
  duration_ms: number;
  provider: string;
  usage: {
    search_requests: number;
  };
  search_warnings?: string[];
  failed_queries?: Array<{
    query: string;
    error: string;
  }>;
}

export interface WebSearchProvider {
  readonly id: string;
  readonly plannedSearchConcurrency?: number;
  search(input: Required<Pick<WebSearchInput, "query">> & WebSearchInput): Promise<WebSearchOutput>;
}

export interface WebSearchMetrics {
  requestCount: number;
  lastProvider: string | null;
  lastQuery: string | null;
  lastError: string | null;
}

export interface WebSearchMetricEvent {
  ts: number;
  provider: string;
  error?: string | null;
}

class WebSearchInputValidationError extends Error {
  readonly code = "web_search_input_validation";
}

const DEFAULT_SEARCH_TIMEOUT_MS = 20_000;

function validateSearchInput(input: WebSearchInput): void {
  if (input.allowed_domains && input.blocked_domains) {
    throw new WebSearchInputValidationError("allowed_domains and blocked_domains cannot both be set");
  }
}

async function fetchSearchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`web search request timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function compactDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function matchesDomain(url: string, domains: string[] | undefined): boolean {
  if (!domains || domains.length === 0) return true;
  const host = compactDomain(url);
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function readMetrics(path: string): WebSearchMetrics {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      requestCount: Number(parsed.requestCount) || 0,
      lastProvider: typeof parsed.lastProvider === "string" ? parsed.lastProvider : null,
      lastQuery: typeof parsed.lastQuery === "string" ? parsed.lastQuery : null,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
    };
  } catch {
    return {
      requestCount: 0,
      lastProvider: null,
      lastQuery: null,
      lastError: null,
    };
  }
}

function metricsPath(butlerData: string): string {
  return join(butlerData, "runtime", "web-search-metrics.json");
}

function usageEventsPath(butlerData: string): string {
  return join(butlerData, "metrics", "web-search-usage.jsonl");
}

export function readWebSearchMetrics(butlerData: string): WebSearchMetrics {
  return readMetrics(metricsPath(butlerData));
}

export function readWebSearchMetricEvents(input: {
  butlerData: string;
  sinceTs?: number;
}): WebSearchMetricEvent[] {
  const path = usageEventsPath(input.butlerData);
  if (!existsSync(path)) return [];
  const events: WebSearchMetricEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as WebSearchMetricEvent;
      if (
        typeof parsed.ts === "number" &&
        typeof parsed.provider === "string" &&
        parsed.provider.trim()
      ) {
        if (input.sinceTs !== undefined && parsed.ts < input.sinceTs) continue;
        events.push({
          ts: parsed.ts,
          provider: parsed.provider,
          error: typeof parsed.error === "string" ? parsed.error : null,
        });
      }
    } catch {
      continue;
    }
  }
  return events;
}

function appendWebSearchMetricEvent(input: {
  butlerData: string;
  provider: string;
  error?: string | null;
  ts?: number;
}): void {
  const path = usageEventsPath(input.butlerData);
  mkdirSync(join(input.butlerData, "metrics"), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      ts: input.ts ?? Date.now(),
      provider: input.provider,
      error: input.error?.trim() || null,
    })}\n`,
    { flag: "a", encoding: "utf8" },
  );
}

export function recordWebSearchMetric(input: {
  butlerData: string;
  provider: string;
  query: string;
  error?: string | null;
  ts?: number;
}): WebSearchMetrics {
  const path = metricsPath(input.butlerData);
  mkdirSync(join(input.butlerData, "runtime"), { recursive: true });
  const current = readMetrics(path);
  const next: WebSearchMetrics = {
    requestCount: current.requestCount + 1,
    lastProvider: input.provider,
    lastQuery: input.query,
    lastError: input.error?.trim() || null,
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  appendWebSearchMetricEvent(input);
  return next;
}

export class MockWebSearchProvider implements WebSearchProvider {
  readonly id = "mock";

  constructor(private readonly fixtures: WebSearchResult[] = [
    {
      title: "Butler Web Search Fixture",
      url: "https://example.com/butler-web-search",
      snippet: "A deterministic search fixture for Butler tests.",
      source: "example.com",
      published_at: "2026-04-26",
    },
  ]) {}

  async search(input: Required<Pick<WebSearchInput, "query">> & WebSearchInput): Promise<WebSearchOutput> {
    const start = Date.now();
    validateSearchInput(input);
    const max = Math.max(1, Math.min(10, Math.trunc(input.max_results ?? 5)));
    const allowed = input.allowed_domains?.map((domain) => domain.trim()).filter(Boolean);
    const blocked = input.blocked_domains?.map((domain) => domain.trim()).filter(Boolean);
    const filtered = this.fixtures
      .filter((result) => matchesDomain(result.url, allowed))
      .filter((result) => !blocked?.some((domain) => matchesDomain(result.url, [domain])))
      .slice(0, max)
      .map((result) => ({
        ...result,
        source: result.source || compactDomain(result.url),
      }));
    return {
      query: input.query,
      results: filtered,
      duration_ms: Math.max(0, Date.now() - start),
      provider: this.id,
      usage: {
        search_requests: 1,
      },
    };
  }
}

export class DisabledWebSearchProvider implements WebSearchProvider {
  readonly id = "disabled";

  constructor(private readonly reason = "web search provider is not configured") {}

  async search(): Promise<WebSearchOutput> {
    throw new Error(this.reason);
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&#x27;/g, "'")
    .trim();
}

function decodeDuckDuckGoUrl(href: string): string | null {
  const decodedHref = decodeHtmlEntities(href);
  try {
    const parsed = decodedHref.startsWith("//")
      ? new URL(`https:${decodedHref}`)
      : decodedHref.startsWith("/")
        ? new URL(decodedHref, "https://duckduckgo.com")
        : new URL(decodedHref);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (parsed.hostname.endsWith("duckduckgo.com")) return null;
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function compactText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isDuckDuckGoChallengePage(html: string): boolean {
  return /id=["']challenge-form["']/iu.test(html) ||
    /class=["'][^"']*\banomaly-modal\b/iu.test(html) ||
    /\/anomaly\.js(?:[?"'])/iu.test(html);
}

export class DuckDuckGoHtmlSearchProvider implements WebSearchProvider {
  readonly id = "duckduckgo-html";
  readonly plannedSearchConcurrency = 2;

  constructor(private readonly options: {
    apiBase?: string;
    timeoutMs?: number;
  } = {}) {}

  async search(input: Required<Pick<WebSearchInput, "query">> & WebSearchInput): Promise<WebSearchOutput> {
    const start = Date.now();
    if (input.allowed_domains && input.blocked_domains) {
      throw new Error("allowed_domains and blocked_domains cannot both be set");
    }
    const url = new URL(this.options.apiBase || "https://html.duckduckgo.com/html/");
    url.searchParams.set("q", input.query);
    const response = await fetchSearchWithTimeout(url, {
      signal: input.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "User-Agent": "Mozilla/5.0 Butler/1.0",
      },
    }, this.options.timeoutMs);
    const html = await response.text();
    if (!response.ok) {
      throw new Error(`DuckDuckGo HTML search failed: HTTP ${response.status}`);
    }
    if (isDuckDuckGoChallengePage(html)) {
      throw new Error(
        "DuckDuckGo HTML search was blocked by an anti-bot challenge; retry later or use another search provider.",
      );
    }
    const dom = new JSDOM(html, { url: url.toString() });
    const document = dom.window.document;
    const max = Math.max(1, Math.min(10, input.max_results ?? 5));
    const allowed = input.allowed_domains?.map((domain) => domain.trim()).filter(Boolean);
    const blocked = input.blocked_domains?.map((domain) => domain.trim()).filter(Boolean);
    const results: WebSearchResult[] = [];
    const seen = new Set<string>();
    for (const result of [...document.querySelectorAll(".result")]) {
      const link = result.querySelector<HTMLAnchorElement>(".result__a");
      if (!link) continue;
      const targetUrl = decodeDuckDuckGoUrl(link.getAttribute("href") || link.href);
      if (!targetUrl || seen.has(targetUrl)) continue;
      if (!matchesDomain(targetUrl, allowed)) continue;
      if (blocked?.some((domain) => matchesDomain(targetUrl, [domain]))) continue;
      seen.add(targetUrl);
      const snippet = compactText(result.querySelector(".result__snippet")?.textContent);
      results.push({
        title: compactText(link.textContent) || targetUrl,
        url: targetUrl,
        snippet,
        source: compactDomain(targetUrl),
      });
      if (results.length >= max) break;
    }
    return {
      query: input.query,
      results,
      duration_ms: Math.max(0, Date.now() - start),
      provider: this.id,
      usage: {
        search_requests: 1,
      },
    };
  }
}

interface OpenAIWebSearchResponse {
  output_text?: string;
  output?: Array<{
    type?: string;
    action?: {
      sources?: Array<{
        title?: string;
        url?: string;
        snippet?: string;
      }>;
    };
    content?: Array<{
      text?: string;
      annotations?: Array<{
        type?: string;
        title?: string;
        url?: string;
      }>;
    }>;
  }>;
}

function sourceResultsFromOpenAIResponse(payload: OpenAIWebSearchResponse): WebSearchResult[] {
  const byUrl = new Map<string, WebSearchResult>();
  for (const item of payload.output ?? []) {
    for (const source of item.action?.sources ?? []) {
      if (!source.url) continue;
      byUrl.set(source.url, {
        title: source.title || source.url,
        url: source.url,
        snippet: source.snippet || "",
        source: compactDomain(source.url),
      });
    }
    for (const content of item.content ?? []) {
      for (const annotation of content.annotations ?? []) {
        if (annotation.type !== "url_citation" || !annotation.url) continue;
        byUrl.set(annotation.url, {
          title: annotation.title || annotation.url,
          url: annotation.url,
          snippet: content.text?.slice(0, 500) || "",
          source: compactDomain(annotation.url),
        });
      }
    }
  }
  return [...byUrl.values()];
}

function filterBlockedDomains(results: WebSearchResult[], blockedDomains: string[] | undefined): WebSearchResult[] {
  if (!blockedDomains || blockedDomains.length === 0) return results;
  return results.filter((result) => !blockedDomains.some((domain) => matchesDomain(result.url, [domain])));
}

export class OpenAIWebSearchProvider implements WebSearchProvider {
  readonly id = "openai-web-search";

  constructor(private readonly options: {
    apiKey: string;
    model?: string;
    apiBase?: string;
  }) {}

  async search(input: Required<Pick<WebSearchInput, "query">> & WebSearchInput): Promise<WebSearchOutput> {
    const start = Date.now();
    validateSearchInput(input);
    const tool: Record<string, unknown> = {
      type: "web_search",
    };
    if (input.allowed_domains?.length) {
      tool.filters = {
        allowed_domains: input.allowed_domains,
      };
    }
    const response = await fetchSearchWithTimeout(`${this.options.apiBase ?? "https://api.openai.com"}/v1/responses`, {
      signal: input.signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.options.model || "gpt-5",
        tools: [tool],
        tool_choice: "auto",
        include: ["web_search_call.action.sources"],
        input: input.query,
      }),
    });
    const payload = await response.json().catch(() => null) as (OpenAIWebSearchResponse & {
      error?: { message?: string };
    }) | null;
    if (!response.ok || !payload) {
      throw new Error(payload?.error?.message || `OpenAI web search failed: HTTP ${response.status}`);
    }
    const results = filterBlockedDomains(sourceResultsFromOpenAIResponse(payload), input.blocked_domains)
      .slice(0, Math.max(1, Math.min(10, input.max_results ?? 5)));
    return {
      query: input.query,
      results,
      duration_ms: Math.max(0, Date.now() - start),
      provider: this.id,
      usage: {
        search_requests: 1,
      },
    };
  }
}

export class BraveWebSearchProvider implements WebSearchProvider {
  readonly id = "brave";

  constructor(private readonly options: {
    apiKey: string;
    apiBase?: string;
  }) {}

  async search(input: Required<Pick<WebSearchInput, "query">> & WebSearchInput): Promise<WebSearchOutput> {
    const start = Date.now();
    validateSearchInput(input);
    const url = new URL(this.options.apiBase || "https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", input.query);
    url.searchParams.set("count", String(Math.max(1, Math.min(10, input.max_results ?? 5))));
    if (input.recency_days) {
      url.searchParams.set("freshness", input.recency_days <= 1 ? "pd" : input.recency_days <= 7 ? "pw" : "pm");
    }
    const response = await fetchSearchWithTimeout(url, {
      signal: input.signal,
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.options.apiKey,
      },
    });
    const payload = await response.json().catch(() => null) as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
          age?: string;
        }>;
      };
      error?: { detail?: string; message?: string };
    } | null;
    if (!response.ok || !payload) {
      throw new Error(payload?.error?.message || payload?.error?.detail || `Brave web search failed: HTTP ${response.status}`);
    }
    const allowed = input.allowed_domains?.map((domain) => domain.trim()).filter(Boolean);
    const results = filterBlockedDomains((payload.web?.results ?? [])
      .filter((result) => result.url)
      .map((result) => ({
        title: result.title || result.url!,
        url: result.url!,
        snippet: result.description || "",
        source: compactDomain(result.url!),
        published_at: result.age,
      }))
      .filter((result) => matchesDomain(result.url, allowed)), input.blocked_domains);
    return {
      query: input.query,
      results,
      duration_ms: Math.max(0, Date.now() - start),
      provider: this.id,
      usage: {
        search_requests: 1,
      },
    };
  }
}

export class TavilyWebSearchProvider implements WebSearchProvider {
  readonly id = "tavily";

  constructor(private readonly options: {
    apiKey: string;
    apiBase?: string;
  }) {}

  async search(input: Required<Pick<WebSearchInput, "query">> & WebSearchInput): Promise<WebSearchOutput> {
    const start = Date.now();
    validateSearchInput(input);
    const response = await fetchSearchWithTimeout(this.options.apiBase || "https://api.tavily.com/search", {
      signal: input.signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        query: input.query,
        search_depth: "basic",
        max_results: Math.max(1, Math.min(10, input.max_results ?? 5)),
        include_domains: input.allowed_domains,
        exclude_domains: input.blocked_domains,
        days: input.recency_days,
      }),
    });
    const payload = await response.json().catch(() => null) as {
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        published_date?: string;
      }>;
      error?: string;
    } | null;
    if (!response.ok || !payload) {
      throw new Error(payload?.error || `Tavily web search failed: HTTP ${response.status}`);
    }
    const results = (payload.results ?? [])
      .filter((result) => result.url)
      .map((result) => ({
        title: result.title || result.url!,
        url: result.url!,
        snippet: result.content || "",
        source: compactDomain(result.url!),
        published_at: result.published_date,
      }));
    return {
      query: input.query,
      results,
      duration_ms: Math.max(0, Date.now() - start),
      provider: this.id,
      usage: {
        search_requests: 1,
      },
    };
  }
}

function parseSseEvents(text: string): Record<string, any>[] {
  const events: Record<string, any>[] = [];
  for (const chunk of text.split(/\r?\n\r?\n/)) {
    const data = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object") events.push(parsed);
    } catch {
      // Ignore keepalive or malformed frames.
    }
  }
  return events;
}

function textFromCodexSse(text: string): string {
  let output = "";
  for (const event of parseSseEvents(text)) {
    if (event.type === "error") {
      throw new Error(`Codex web search error: ${event.message || event.code || JSON.stringify(event)}`);
    }
    if (event.type === "response.failed") {
      const error = event.response?.error;
      throw new Error(`Codex web search error: ${error?.message || error?.code || JSON.stringify(event.response)}`);
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      output += event.delta;
    }
    if (!output && event.type === "response.output_text.done" && typeof event.text === "string") {
      output = event.text;
    }
    if (!output && event.type === "response.output_item.done") {
      for (const content of event.item?.content ?? []) {
        if (typeof content?.text === "string") output += content.text;
      }
    }
  }
  return output.trim();
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)\]}>"']+/g) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.,;:]+$/g, "")))];
}

function codexSubscriptionModel(model: string | undefined): string {
  const trimmed = model?.trim() || "";
  if (/^gpt-\d+(?:\.\d+)*-codex$/i.test(trimmed)) {
    return trimmed.replace(/-codex$/i, "");
  }
  if (!trimmed) {
    throw new Error("Codex subscription model is required; no model fallback is allowed.");
  }
  return trimmed;
}

function codexResponsesUrl(apiBase?: string): string {
  const base = (apiBase?.trim() || process.env.BUTLER_CODEX_BASE_URL?.trim() || "https://chatgpt.com/backend-api")
    .replace(/\/+$/, "");
  if (base.endsWith("/codex/responses")) return base;
  if (base.endsWith("/codex")) return `${base}/responses`;
  return `${base}/codex/responses`;
}

function codexOriginator(): string {
  return process.env.BUTLER_CODEX_OAUTH_ORIGINATOR?.trim() ||
    process.env.BUTLER_OPENAI_OAUTH_ORIGINATOR?.trim() ||
    "butler";
}

function codexUserAgent(): string {
  return process.env.BUTLER_CODEX_USER_AGENT?.trim() ||
    `butler (${platform()} ${release()}; ${arch()})`;
}

export class CodexSubscriptionWebSearchProvider implements WebSearchProvider {
  readonly id = "codex-subscription-web-search";

  constructor(private readonly options: {
    authorization: string;
    model?: string;
    apiBase?: string;
  }) {}

  async search(input: Required<Pick<WebSearchInput, "query">> & WebSearchInput): Promise<WebSearchOutput> {
    const start = Date.now();
    validateSearchInput(input);
    const token = this.options.authorization.replace(/^Bearer\s+/i, "");
    const accountId = accountIdFromAccessToken(token);
    if (!accountId) throw new Error("Codex subscription token did not include a ChatGPT account id");
    const tool: Record<string, unknown> = { type: "web_search" };
    if (input.allowed_domains?.length) {
      tool.filters = { allowed_domains: input.allowed_domains };
    }
    const response = await fetchSearchWithTimeout(codexResponsesUrl(this.options.apiBase), {
      signal: input.signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.options.authorization,
        "chatgpt-account-id": accountId,
        "openai-beta": "responses=experimental",
        originator: codexOriginator(),
        "user-agent": codexUserAgent(),
      },
      body: JSON.stringify({
        model: codexSubscriptionModel(this.options.model),
        instructions: "Use web search and return concise source URLs.",
        input: [{
          role: "user",
          content: [{
            type: "input_text",
            text: input.query,
          }],
        }],
        tools: [tool],
        tool_choice: "auto",
        stream: true,
        store: false,
      }),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Codex web search error (${response.status}): ${raw.slice(0, 500)}`);
    }
    const answer = textFromCodexSse(raw);
    const max = Math.max(1, Math.min(10, input.max_results ?? 5));
    const results = filterBlockedDomains(extractUrls(answer).map((url) => ({
      title: compactDomain(url),
      url,
      snippet: answer.slice(0, 500),
      source: compactDomain(url),
    })), input.blocked_domains).slice(0, max);
    return {
      query: input.query,
      results,
      duration_ms: Math.max(0, Date.now() - start),
      provider: this.id,
      usage: {
        search_requests: 1,
      },
    };
  }
}

function isValidationError(error: unknown): boolean {
  return error instanceof WebSearchInputValidationError;
}

export class FallbackWebSearchProvider implements WebSearchProvider {
  readonly id: string;
  readonly plannedSearchConcurrency: number;

  constructor(
    private readonly primary: WebSearchProvider,
    private readonly fallback: WebSearchProvider = new DuckDuckGoHtmlSearchProvider(),
  ) {
    this.id = `${primary.id}-with-${fallback.id}-fallback`;
    this.plannedSearchConcurrency = Math.min(
      primary.plannedSearchConcurrency ?? Number.POSITIVE_INFINITY,
      fallback.plannedSearchConcurrency ?? Number.POSITIVE_INFINITY,
    );
  }

  async search(input: Required<Pick<WebSearchInput, "query">> & WebSearchInput): Promise<WebSearchOutput> {
    try {
      return await this.primary.search(input);
    } catch (error) {
      if (isValidationError(error)) throw error;
      return await this.fallback.search(input);
    }
  }
}

export class ConfiguredCodexSubscriptionWebSearchProvider implements WebSearchProvider {
  readonly id = "codex-subscription-web-search";

  constructor(private readonly options: {
    model?: string;
    apiBase?: string;
  } = {}) {}

  async search(input: Required<Pick<WebSearchInput, "query">> & WebSearchInput): Promise<WebSearchOutput> {
    const auth = await resolveOpenAIAuth();
    if (auth.mode !== "codex_subscription" && auth.mode !== "codex_oauth") {
      throw new Error("Codex subscription login is required for codex-subscription-web-search");
    }
    return await new CodexSubscriptionWebSearchProvider({
      authorization: auth.authorization,
      model: this.options.model,
      apiBase: this.options.apiBase,
    }).search(input);
  }
}

export class AutoWebSearchProvider implements WebSearchProvider {
  readonly id = "auto-web-search";
  readonly plannedSearchConcurrency = 2;

  constructor(private readonly options: {
    model?: string;
    apiBase?: string;
    braveApiBase?: string;
    tavilyApiBase?: string;
  } = {}) {}

  async search(input: Required<Pick<WebSearchInput, "query">> & WebSearchInput): Promise<WebSearchOutput> {
    const braveKey = process.env.BUTLER_BRAVE_SEARCH_API_KEY?.trim() || process.env.BRAVE_SEARCH_API_KEY?.trim();
    if (braveKey) {
      return await new FallbackWebSearchProvider(new BraveWebSearchProvider({
        apiKey: braveKey,
        apiBase: this.options.braveApiBase,
      })).search(input);
    }
    const tavilyKey = process.env.BUTLER_TAVILY_API_KEY?.trim() || process.env.TAVILY_API_KEY?.trim();
    if (tavilyKey) {
      return await new FallbackWebSearchProvider(new TavilyWebSearchProvider({
        apiKey: tavilyKey,
        apiBase: this.options.tavilyApiBase,
      })).search(input);
    }
    try {
      const auth = await resolveOpenAIAuth();
      if (auth.mode === "api_key") {
        return await new FallbackWebSearchProvider(new OpenAIWebSearchProvider({
          apiKey: auth.authorization.replace(/^Bearer\s+/i, ""),
          model: this.options.model,
          apiBase: this.options.apiBase,
        })).search(input);
      }
      return await new FallbackWebSearchProvider(new CodexSubscriptionWebSearchProvider({
        authorization: auth.authorization,
        model: this.options.model,
        apiBase: this.options.apiBase,
      })).search(input);
    } catch (error) {
      if (isValidationError(error)) throw error;
      return await new DuckDuckGoHtmlSearchProvider().search(input);
    }
  }
}

export function createConfiguredWebSearchProvider(options: {
  butlerData: string;
  provider?: WebSearchProvider;
}): WebSearchProvider {
  if (options.provider) return options.provider;
  const configPath = join(options.butlerData, "butler.config.json");
  let config: Record<string, any> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      // Fall through to the default no-key provider below.
    }
  }
  const provider = String(process.env.BUTLER_WEB_SEARCH_PROVIDER || config?.webSearch?.provider || "duckduckgo-html").trim();
  if (provider === "mock") return new MockWebSearchProvider();
  if (provider === "duckduckgo-html" || provider === "duckduckgo") return new DuckDuckGoHtmlSearchProvider();
  if (provider === "disabled") {
    return new DisabledWebSearchProvider();
  }
  if (provider === "brave") {
    const apiKey = process.env.BUTLER_BRAVE_SEARCH_API_KEY?.trim() || process.env.BRAVE_SEARCH_API_KEY?.trim();
    return apiKey
      ? new FallbackWebSearchProvider(new BraveWebSearchProvider({ apiKey, apiBase: config?.webSearch?.braveApiBase }))
      : new DuckDuckGoHtmlSearchProvider();
  }
  if (provider === "tavily") {
    const apiKey = process.env.BUTLER_TAVILY_API_KEY?.trim() || process.env.TAVILY_API_KEY?.trim();
    return apiKey
      ? new FallbackWebSearchProvider(new TavilyWebSearchProvider({ apiKey, apiBase: config?.webSearch?.tavilyApiBase }))
      : new DuckDuckGoHtmlSearchProvider();
  }
  if (provider === "openai-web-search") {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    return apiKey
      ? new FallbackWebSearchProvider(new OpenAIWebSearchProvider({
        apiKey,
        model: typeof config?.webSearch?.model === "string" ? config.webSearch.model : undefined,
        apiBase: typeof config?.webSearch?.apiBase === "string" ? config.webSearch.apiBase : undefined,
      }))
      : new DuckDuckGoHtmlSearchProvider();
  }
  if (provider === "codex-subscription-web-search") {
    return new FallbackWebSearchProvider(new ConfiguredCodexSubscriptionWebSearchProvider({
      model: typeof config?.webSearch?.model === "string" ? config.webSearch.model : undefined,
      apiBase: typeof config?.webSearch?.apiBase === "string" ? config.webSearch.apiBase : undefined,
    }));
  }
  if (provider === "auto") {
    return new AutoWebSearchProvider({
      model: typeof config?.webSearch?.model === "string" ? config.webSearch.model : undefined,
      apiBase: typeof config?.webSearch?.apiBase === "string" ? config.webSearch.apiBase : undefined,
      braveApiBase: typeof config?.webSearch?.braveApiBase === "string" ? config.webSearch.braveApiBase : undefined,
      tavilyApiBase: typeof config?.webSearch?.tavilyApiBase === "string" ? config.webSearch.tavilyApiBase : undefined,
    });
  }
  return new DuckDuckGoHtmlSearchProvider();
}
