import { accessSync, constants, existsSync, readFileSync } from "fs";
import { join } from "path";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

export interface PageReadRequest {
  url: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type PageReaderBackendId = "auto" | "lightpanda" | "lightweight" | "jina-hosted" | "disabled";

export interface PageReadResult {
  reader: "butler-lightweight" | "lightpanda" | "jina-hosted" | "disabled";
  requestedUrl: string;
  finalUrl: string;
  ok: boolean;
  status?: number;
  title?: string;
  text: string;
  markdown: string;
  document: string;
  chunks: EvidenceChunk[];
  method: "readability" | "raw-html" | "plain-text" | "github-raw";
  durationMs: number;
  warnings: string[];
  renderRecommended: boolean;
  error?: string;
}

export interface ConfiguredPageReadRequest extends PageReadRequest {
  butlerData: string;
  backend?: PageReaderBackendId;
}

export interface EvidenceChunk {
  id: string;
  index: number;
  title?: string;
  url: string;
  text: string;
  charCount: number;
}

interface FetchAttempt {
  url: string;
  response: Response;
  body: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CHUNK_SIZE = 1_500;
const DEFAULT_CHUNK_OVERLAP = 180;
const DEFAULT_LIGHTPANDA_WAIT_MS = 5_000;
const LIGHTPANDA_CANDIDATE_PATHS = [
  "/opt/homebrew/bin/lightpanda",
  "/usr/local/bin/lightpanda",
  "/usr/bin/lightpanda",
];
const READER_BACKENDS = new Set<PageReaderBackendId>([
  "auto",
  "lightpanda",
  "lightweight",
  "jina-hosted",
  "disabled",
]);

export function normalizePageReaderBackend(value: unknown): PageReaderBackendId {
  if (typeof value !== "string") return "lightweight";
  const normalized = value.trim().toLowerCase();
  return READER_BACKENDS.has(normalized as PageReaderBackendId)
    ? normalized as PageReaderBackendId
    : "lightweight";
}

export function configuredPageReaderBackend(input: {
  butlerData: string;
  override?: string;
}): PageReaderBackendId {
  const env = process.env.BUTLER_WEB_READER_BACKEND?.trim();
  if (env) return normalizePageReaderBackend(env);
  if (input.override) return normalizePageReaderBackend(input.override);
  const configPath = join(input.butlerData, "butler.config.json");
  try {
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      return normalizePageReaderBackend(config?.webSearch?.readerBackend);
    }
  } catch {
    return "lightweight";
  }
  return "lightweight";
}

function executablePath(path: string | undefined): string | null {
  const explicit = path?.trim();
  if (explicit) {
    try {
      accessSync(explicit, constants.X_OK);
      return explicit;
    } catch {
      return null;
    }
  }
  return null;
}

function resolveLightpandaBinary(): string | null {
  if (process.env.BUTLER_LIGHTPANDA_BIN?.trim()) return executablePath(process.env.BUTLER_LIGHTPANDA_BIN);
  if (process.env.LIGHTPANDA_BIN?.trim()) return executablePath(process.env.LIGHTPANDA_BIN);
  for (const candidate of LIGHTPANDA_CANDIDATE_PATHS) {
    const resolved = executablePath(candidate);
    if (resolved) return resolved;
  }
  return null;
}

function disabledPageReadResult(request: PageReadRequest, started: number): PageReadResult {
  return {
    reader: "disabled",
    requestedUrl: request.url,
    finalUrl: request.url,
    ok: false,
    text: "",
    markdown: "",
    document: "",
    chunks: [],
    method: "raw-html",
    durationMs: Date.now() - started,
    warnings: ["page-reader-disabled"],
    renderRecommended: false,
    error: "page reader backend is disabled",
  };
}

function withBackendWarning(result: PageReadResult, warning: string): PageReadResult {
  return {
    ...result,
    warnings: [...new Set([...result.warnings, warning])],
    document: result.document
      ? result.document.replace(/^Warnings: .+$/m, `Warnings: ${[...new Set([...result.warnings, warning])].join(", ")}`)
      : result.document,
  };
}

export function githubRawUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  const blobIndex = parts.indexOf("blob");
  if (blobIndex !== 2 || parts.length < 5) return null;
  const [owner, repo] = parts;
  const ref = parts[3];
  const path = parts.slice(4).join("/");
  if (!owner || !repo || !ref || !path) return null;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
}

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleFromHtml(html: string): string | undefined {
  return html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
}

function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\n{4,}/g, "\n\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function createTurndown(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndown.keep(["table", "thead", "tbody", "tr", "th", "td"]);
  turndown.addRule("preCode", {
    filter: (node) =>
      node.nodeName === "PRE" &&
      node.firstChild?.nodeName === "CODE",
    replacement: (_content, node) => {
      const code = node.textContent?.replace(/\n+$/g, "") ?? "";
      return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
    },
  });
  return turndown;
}

function htmlToMarkdown(html: string): string {
  return normalizeMarkdown(createTurndown().turndown(html));
}

function plainTextToMarkdown(text: string): string {
  return normalizeMarkdown(`\`\`\`\n${text.trim()}\n\`\`\``);
}

function simpleHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

export function chunkEvidence(input: {
  markdown: string;
  title?: string;
  url: string;
  chunkSize?: number;
  overlap?: number;
}): EvidenceChunk[] {
  const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = input.overlap ?? DEFAULT_CHUNK_OVERLAP;
  const text = input.markdown.trim();
  if (!text) return [];
  const chunks: EvidenceChunk[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + chunkSize);
    if (end < text.length) {
      const boundary = text.lastIndexOf("\n\n", end);
      if (boundary > offset + Math.floor(chunkSize * 0.45)) end = boundary;
    }
    const chunkText = text.slice(offset, end).trim();
    if (chunkText) {
      const index = chunks.length;
      chunks.push({
        id: `ev_${simpleHash(`${input.url}:${index}:${chunkText.slice(0, 160)}`)}`,
        index,
        title: input.title,
        url: input.url,
        text: chunkText,
        charCount: chunkText.length,
      });
    }
    if (end >= text.length) break;
    offset = Math.max(end - overlap, offset + 1);
  }
  return chunks;
}

export function buildEvidenceDocument(input: {
  title?: string;
  url: string;
  method: PageReadResult["method"];
  markdown: string;
  warnings: string[];
  chunks: EvidenceChunk[];
  reader?: PageReadResult["reader"];
}): string {
  const warnings = input.warnings.length ? input.warnings.join(", ") : "none";
  const previews = input.chunks
    .map((chunk) => `- ${chunk.id}: ${chunk.text.replace(/\s+/g, " ").slice(0, 140)}`)
    .join("\n") || "- none";
  return [
    `Title: ${input.title || "unknown"}`,
    `URL Source: ${input.url}`,
    `Reader: ${input.reader ?? "butler-lightweight"}`,
    `Extraction Method: ${input.method}`,
    `Warnings: ${warnings}`,
    "",
    "Markdown Content:",
    input.markdown || "(empty)",
    "",
    "Evidence Chunks:",
    previews,
  ].join("\n").trim();
}

export function pageWarnings(input: {
  body: string;
  text: string;
  contentType?: string | null;
  method: PageReadResult["method"];
}): string[] {
  const warnings: string[] = [];
  const scriptCount = (input.body.match(/<script\b/gi) ?? []).length;
  if (scriptCount >= 8 && input.text.length < 1_000) warnings.push("likely-csr-app-shell");
  if (/enable javascript|requires javascript|please enable javascript/i.test(input.body)) {
    warnings.push("javascript-required");
  }
  if (/challenge-platform|__cf_chl|turnstile|just a moment|verification successful/i.test(input.body)) {
    warnings.push("cloudflare-challenge");
  }
  if (/login|sign in|captcha|access denied|blocked/i.test(input.text.slice(0, 2_000))) {
    warnings.push("possible-login-or-block");
  }
  if (input.text.length > 0 && input.text.length < 500) warnings.push("tiny-content");
  if (input.method === "raw-html") warnings.push("readability-fallback-to-raw-html");
  if (input.contentType && !/html|text|json|xml|javascript|typescript/i.test(input.contentType)) {
    warnings.push(`unexpected-content-type:${input.contentType}`);
  }
  return [...new Set(warnings)];
}

export function shouldRecommendRender(result: Pick<PageReadResult, "text" | "warnings" | "method">): boolean {
  if (result.warnings.some((warning) =>
    warning === "likely-csr-app-shell" ||
    warning === "javascript-required" ||
    warning === "cloudflare-challenge" ||
    warning === "possible-login-or-block",
  )) return true;
  if (result.warnings.includes("tiny-content") && /loading|enable javascript|requires javascript/i.test(result.text)) {
    return true;
  }
  if (result.text.length < 50 && result.method !== "github-raw") return true;
  return false;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<FetchAttempt> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "butler-lightweight-page-reader/0.1",
        accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.5",
      },
    });
    return {
      url: response.url || url,
      response,
      body: await response.text(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isTextLike(contentType: string | null): boolean {
  return Boolean(contentType && /text|json|javascript|typescript|xml/i.test(contentType));
}

function extract(attempt: FetchAttempt): Omit<PageReadResult, "reader" | "requestedUrl" | "durationMs" | "renderRecommended" | "document" | "chunks"> {
  const contentType = attempt.response.headers.get("content-type");
  if (isTextLike(contentType) && !/html|xml/i.test(contentType ?? "")) {
    const text = attempt.body.trim();
    const method = attempt.url.includes("raw.githubusercontent.com") ? "github-raw" : "plain-text";
    const markdown = plainTextToMarkdown(text);
    return {
      finalUrl: attempt.url,
      ok: attempt.response.ok && text.length > 0,
      status: attempt.response.status,
      text,
      markdown,
      method,
      warnings: pageWarnings({ body: attempt.body, text, contentType, method }),
    };
  }

  const dom = new JSDOM(attempt.body, { url: attempt.url });
  const parsed = new Readability(dom.window.document).parse();
  const readabilityHtml = parsed?.content || "";
  const readabilityText = stripHtmlToText(readabilityHtml || parsed?.textContent || "");
  const rawText = stripHtmlToText(attempt.body);
  const method = readabilityText.length >= 200 || readabilityText.length >= rawText.length * 0.25
    ? "readability"
    : "raw-html";
  const text = method === "readability" ? readabilityText : rawText;
  const markdown = method === "readability" && readabilityHtml
    ? htmlToMarkdown(readabilityHtml)
    : normalizeMarkdown(rawText);
  return {
    finalUrl: attempt.url,
    ok: attempt.response.ok && text.length > 0,
    status: attempt.response.status,
    title: parsed?.title || titleFromHtml(attempt.body),
    text,
    markdown,
    method,
    warnings: pageWarnings({ body: attempt.body, text, contentType, method }),
  };
}

function needsGithubRawRetry(originalUrl: string, result: Pick<PageReadResult, "method" | "warnings" | "text">): boolean {
  if (!githubRawUrl(originalUrl)) return false;
  if (result.method === "github-raw") return false;
  if (result.warnings.includes("possible-login-or-block")) return true;
  if (!/function|const|export|import|class|=>/.test(result.text)) return true;
  return false;
}

export async function readPageLightweight(request: PageReadRequest): Promise<PageReadResult> {
  const started = Date.now();
  const fetchImpl = request.fetchImpl ?? fetch;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const first = extract(await fetchWithTimeout(request.url, timeoutMs, fetchImpl));
    let selected = first;
    const rawUrl = githubRawUrl(request.url);
    if (rawUrl && needsGithubRawRetry(request.url, first)) {
      const raw = extract(await fetchWithTimeout(rawUrl, timeoutMs, fetchImpl));
      if (raw.text.length > first.text.length || raw.method === "github-raw") selected = raw;
    }
    const renderRecommended = shouldRecommendRender(selected);
    const chunks = chunkEvidence({
      markdown: selected.markdown,
      title: selected.title,
      url: selected.finalUrl,
    });
    const document = buildEvidenceDocument({
      title: selected.title,
      url: selected.finalUrl,
      method: selected.method,
      markdown: selected.markdown,
      warnings: selected.warnings,
      chunks,
    });
    return {
      reader: "butler-lightweight",
      requestedUrl: request.url,
      ...selected,
      document,
      chunks,
      durationMs: Date.now() - started,
      renderRecommended,
    };
  } catch (error) {
    return {
      reader: "butler-lightweight",
      requestedUrl: request.url,
      finalUrl: request.url,
      ok: false,
      text: "",
      markdown: "",
      document: "",
      chunks: [],
      method: "raw-html",
      durationMs: Date.now() - started,
      warnings: [],
      renderRecommended: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function lightpandaWaitMs(timeoutMs: number): number {
  const configured = Number.parseInt(process.env.BUTLER_LIGHTPANDA_WAIT_MS ?? "", 10);
  const requested = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_LIGHTPANDA_WAIT_MS;
  return Math.max(0, Math.min(requested, Math.max(500, timeoutMs - 1_000)));
}

async function runLightpandaHtmlDump(input: {
  binary: string;
  url: string;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const proc = Bun.spawn([
    input.binary,
    "fetch",
    "--dump",
    "html",
    "--log-format",
    "pretty",
    "--log-level",
    "warn",
    "--wait-ms",
    String(lightpandaWaitMs(input.timeoutMs)),
    input.url,
  ], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      LIGHTPANDA_DISABLE_TELEMETRY: "true",
    },
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, input.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, timedOut };
  } finally {
    clearTimeout(timeout);
  }
}

function extractionScore(result: Pick<PageReadResult, "ok" | "text" | "warnings" | "method" | "chunks">): number {
  let score = result.ok ? 40 : 0;
  score += Math.min(40, Math.floor(result.text.length / 100));
  score += Math.min(15, result.chunks.length * 3);
  if (result.method === "readability") score += 8;
  if (result.warnings.includes("cloudflare-challenge")) score -= 45;
  if (result.warnings.includes("javascript-required")) score -= 30;
  if (result.warnings.includes("likely-csr-app-shell")) score -= 30;
  if (result.warnings.includes("possible-login-or-block")) score -= 20;
  if (result.warnings.includes("tiny-content")) score -= 10;
  return score;
}

function shouldUseLightpandaResult(lightweight: PageReadResult, lightpanda: PageReadResult): boolean {
  if (!lightpanda.ok || lightpanda.text.trim().length === 0) return false;
  const lightpandaScore = extractionScore(lightpanda);
  const lightweightScore = extractionScore(lightweight);
  if (lightpandaScore >= lightweightScore + 10) return true;
  if (lightweight.warnings.includes("javascript-required") && lightpanda.text.length >= 500) return true;
  if (lightweight.warnings.includes("likely-csr-app-shell") && lightpanda.text.length >= lightweight.text.length * 1.5) return true;
  return false;
}

export async function readPageLightpanda(request: PageReadRequest & { binary?: string }): Promise<PageReadResult> {
  const started = Date.now();
  const binary = request.binary ?? resolveLightpandaBinary();
  if (!binary) {
    return {
      reader: "lightpanda",
      requestedUrl: request.url,
      finalUrl: request.url,
      ok: false,
      text: "",
      markdown: "",
      document: "",
      chunks: [],
      method: "raw-html",
      durationMs: Date.now() - started,
      warnings: ["lightpanda-unavailable"],
      renderRecommended: true,
      error: "Lightpanda binary is not configured or executable",
    };
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const dump = await runLightpandaHtmlDump({ binary, url: request.url, timeoutMs });
    if (dump.timedOut || dump.exitCode !== 0 || dump.stdout.trim().length === 0) {
      const reason = dump.timedOut ? "timed out" : `exit ${dump.exitCode}`;
      return {
        reader: "lightpanda",
        requestedUrl: request.url,
        finalUrl: request.url,
        ok: false,
        text: "",
        markdown: "",
        document: "",
        chunks: [],
        method: "raw-html",
        durationMs: Date.now() - started,
        warnings: ["lightpanda-render-failed"],
        renderRecommended: true,
        error: `${reason}${dump.stderr.trim() ? `: ${dump.stderr.trim().slice(0, 500)}` : ""}`,
      };
    }

    const extracted = extract({
      url: request.url,
      response: new Response(dump.stdout, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      body: dump.stdout,
    });
    const warnings = [...new Set([...extracted.warnings, "lightpanda-rendered-fallback-used"])];
    const chunks = chunkEvidence({
      markdown: extracted.markdown,
      title: extracted.title,
      url: extracted.finalUrl,
    });
    const document = buildEvidenceDocument({
      title: extracted.title,
      url: extracted.finalUrl,
      method: extracted.method,
      markdown: extracted.markdown,
      warnings,
      chunks,
      reader: "lightpanda",
    });
    return {
      reader: "lightpanda",
      requestedUrl: request.url,
      ...extracted,
      warnings,
      chunks,
      document,
      durationMs: Date.now() - started,
      renderRecommended: shouldRecommendRender({ ...extracted, warnings }),
    };
  } catch (error) {
    return {
      reader: "lightpanda",
      requestedUrl: request.url,
      finalUrl: request.url,
      ok: false,
      text: "",
      markdown: "",
      document: "",
      chunks: [],
      method: "raw-html",
      durationMs: Date.now() - started,
      warnings: ["lightpanda-render-failed"],
      renderRecommended: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readPageConfigured(request: ConfiguredPageReadRequest): Promise<PageReadResult> {
  const started = Date.now();
  const backend = request.backend ?? configuredPageReaderBackend({
    butlerData: request.butlerData,
  });

  if (backend === "disabled") {
    return disabledPageReadResult(request, started);
  }

  if (backend === "lightweight") {
    return readPageLightweight(request);
  }

  if (backend === "jina-hosted") {
    const lightweight = await readPageLightweight(request);
    return withBackendWarning(lightweight, "jina-hosted-reader-not-yet-enabled");
  }

  if (backend === "lightpanda" || backend === "auto") {
    const lightweight = await readPageLightweight(request);
    if (!lightweight.renderRecommended) return lightweight;
    const binary = resolveLightpandaBinary();
    if (!binary) {
      return withBackendWarning(lightweight, "lightpanda-unavailable-fell-back-to-lightweight");
    }
    const rendered = await readPageLightpanda({ ...request, binary });
    if (shouldUseLightpandaResult(lightweight, rendered)) {
      return rendered;
    }
    const warning = rendered.error
      ? `lightpanda-render-fallback-rejected:${rendered.error.slice(0, 120)}`
      : "lightpanda-render-fallback-rejected";
    return withBackendWarning(lightweight, warning);
  }

  return readPageLightweight(request);
}
