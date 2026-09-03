import { accessSync, constants, existsSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "node:url";
import { shouldRecommendRender } from "./page-extraction.ts";
import type { PageExtractionResult } from "./page-extraction.ts";
export { stripHtmlToText, titleFromHtml, pageWarnings, shouldRecommendRender } from "./page-extraction.ts";

export interface PageReadRequest {
  url: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
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
  method: "readability" | "raw-html" | "plain-text" | "github-raw" | "pdf" | "unsupported";
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
  bytes: Uint8Array;
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

interface ReadBudget {
  signal: AbortSignal;
  deadline: number;
}

async function withReadBudget<T>(request: PageReadRequest, read: (budget: ReadBudget) => Promise<T>): Promise<T> {
  request.signal?.throwIfAborted();
  const controller = new AbortController();
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const timeout = setTimeout(() => {
    controller.abort(new DOMException("Page read timed out.", "TimeoutError"));
  }, timeoutMs);
  const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
  try {
    return await read({ signal, deadline });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPageBytes(url: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<FetchAttempt> {
  signal.throwIfAborted();
  const response = await fetchImpl(url, {
    signal,
    headers: {
      "user-agent": "butler-lightweight-page-reader/0.1",
      accept: "text/html,application/xhtml+xml,application/pdf,text/plain,application/json;q=0.8,*/*;q=0.5",
    },
  });
  signal.throwIfAborted();
  const reader = response.body?.getReader();
  if (!reader) return { url: response.url || url, response, bytes: new Uint8Array() };
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const parts: Uint8Array[] = [];
    let length = 0;
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      parts.push(next.value);
      length += next.value.length;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return { url: response.url || url, response, bytes };
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

async function extract(attempt: FetchAttempt, signal: AbortSignal): Promise<PageExtractionResult> {
  signal.throwIfAborted();
  // Bun workers cannot interrupt all synchronous parser work. A one-shot process
  // gives cancellation a real kill boundary and ships with the existing source payload.
  const message: { result?: PageExtractionResult; error?: string } = {};
  const proc = Bun.spawn([
    process.execPath,
    fileURLToPath(new URL("./page-extraction-process.ts", import.meta.url)),
    attempt.url,
    attempt.response.headers.get("content-type") ?? "",
    String(attempt.response.status),
  ], {
    stdin: "pipe", stdout: "ignore", stderr: "ignore",
    ipc(result: typeof message) { Object.assign(message, result); },
  });
  const abort = () => proc.kill("SIGKILL");
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    proc.stdin.write(attempt.bytes);
    await proc.stdin.end();
    const exitCode = await proc.exited;
    signal.throwIfAborted();
    if (exitCode !== 0) throw new Error("Page extraction process failed.");
    if (!message.result) throw new Error(message.error || "Page extraction failed.");
    return message.result;
  } finally {
    signal.removeEventListener("abort", abort);
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

function needsGithubRawRetry(originalUrl: string, result: Pick<PageReadResult, "method" | "warnings" | "text">): boolean {
  if (result.method === "pdf" || result.method === "unsupported") return false;
  if (!githubRawUrl(originalUrl)) return false;
  if (result.method === "github-raw") return false;
  if (result.warnings.includes("possible-login-or-block")) return true;
  if (!/function|const|export|import|class|=>/.test(result.text)) return true;
  return false;
}

export async function readPageLightweight(request: PageReadRequest): Promise<PageReadResult> {
  return withReadBudget(request, (budget) => readLightweight(request, budget));
}

async function readLightweight(request: PageReadRequest, budget: ReadBudget): Promise<PageReadResult> {
  const started = Date.now();
  const fetchImpl = request.fetchImpl ?? fetch;
  let finalUrl = request.url;
  try {
    const attempt = await fetchPageBytes(request.url, fetchImpl, budget.signal);
    finalUrl = attempt.url;
    const first = await extract(attempt, budget.signal);
    let selected = first;
    const rawUrl = githubRawUrl(request.url);
    if (rawUrl && needsGithubRawRetry(request.url, first)) {
      const raw = await extract(await fetchPageBytes(rawUrl, fetchImpl, budget.signal), budget.signal);
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
    if (request.signal?.aborted) throw pageReadAbortError(request.signal);
    return {
      reader: "butler-lightweight",
      requestedUrl: request.url,
      finalUrl,
      ok: false,
      text: "",
      markdown: "",
      document: "",
      chunks: [],
      method: "raw-html",
      durationMs: Date.now() - started,
      warnings: [],
      renderRecommended: !budget.signal.aborted,
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
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  input.signal?.throwIfAborted();
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
  const abort = () => proc.kill();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, timedOut: input.signal?.aborted ?? false };
  } finally {
    input.signal?.removeEventListener("abort", abort);
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
  return withReadBudget(request, (budget) => readLightpanda(request, budget));
}

async function readLightpanda(request: PageReadRequest & { binary?: string }, budget: ReadBudget): Promise<PageReadResult> {
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

  const timeoutMs = Math.max(1, budget.deadline - Date.now());
  try {
    budget.signal.throwIfAborted();
    const dump = await runLightpandaHtmlDump({
      binary,
      url: request.url,
      timeoutMs,
      signal: budget.signal,
    });
    budget.signal.throwIfAborted();
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

    const extracted = await extract({
      url: request.url,
      response: new Response(dump.stdout, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      bytes: new TextEncoder().encode(dump.stdout),
    }, budget.signal);
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
    if (request.signal?.aborted) throw pageReadAbortError(request.signal);
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

function pageReadAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Page read was cancelled.");
  error.name = "AbortError";
  return error;
}

export async function readPageConfigured(request: ConfiguredPageReadRequest): Promise<PageReadResult> {
  const started = Date.now();
  const result = await withReadBudget(request, (budget) => readConfigured(request, budget));
  return { ...result, durationMs: Date.now() - started };
}

async function readConfigured(request: ConfiguredPageReadRequest, budget: ReadBudget): Promise<PageReadResult> {
  const started = Date.now();
  const backend = request.backend ?? configuredPageReaderBackend({
    butlerData: request.butlerData,
  });

  if (backend === "disabled") {
    return disabledPageReadResult(request, started);
  }

  if (backend === "lightweight") {
    return readLightweight(request, budget);
  }

  if (backend === "jina-hosted") {
    const lightweight = await readLightweight(request, budget);
    return withBackendWarning(lightweight, "jina-hosted-reader-not-yet-enabled");
  }

  if (backend === "lightpanda" || backend === "auto") {
    const lightweight = await readLightweight(request, budget);
    if (!lightweight.renderRecommended || budget.signal.aborted) return lightweight;
    const binary = resolveLightpandaBinary();
    if (!binary) {
      return withBackendWarning(lightweight, "lightpanda-unavailable-fell-back-to-lightweight");
    }
    const rendered = await readLightpanda({ ...request, binary }, budget);
    if (shouldUseLightpandaResult(lightweight, rendered)) {
      return rendered;
    }
    const warning = rendered.error
      ? `lightpanda-render-fallback-rejected:${rendered.error.slice(0, 120)}`
      : "lightpanda-render-fallback-rejected";
    return withBackendWarning(lightweight, warning);
  }

  return readLightweight(request, budget);
}
