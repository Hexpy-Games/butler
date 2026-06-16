import { readPageConfigured, type PageReaderBackendId, type PageReadResult } from "../../../integrations/search/page-reader.ts";
import { evidenceReceipt, urlReferences } from "../executor-support.ts";

type WebReadToolCall = { args: Record<string, unknown> };

export function createWebReadHandler(input: {
  butlerData: string;
  pageReader?: typeof readPageConfigured;
}): (call: WebReadToolCall) => Promise<Record<string, unknown>> {
  const pageReadCache = new Map<string, PageReadResult>();
  return async (call) => {
    const url = typeof call.args.url === "string" ? call.args.url.trim() : "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("web_read requires a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("web_read only supports http(s) URLs");
    }
    const requestedMaxChunks = call.args.max_chunks;
    const maxChars = typeof call.args.max_chars === "number"
      ? Math.max(500, Math.min(8_000, Math.trunc(call.args.max_chars)))
      : 2_000;
    const maxChunks = typeof requestedMaxChunks === "number"
      ? Math.max(1, Math.min(8, Math.trunc(requestedMaxChunks)))
      : 1;
    const backend = pageReaderBackend(call.args.backend);
    const readPage = input.pageReader ?? readPageConfigured;
    const cacheKey = backend + ":" + parsed.href;
    const cached = pageReadCache.get(cacheKey);
    const result = cached ?? await readPage({
      butlerData: input.butlerData,
      url,
      backend,
    });
    if (!cached) pageReadCache.set(cacheKey, result);
    const bounded = boundedPageReadToolResult(result, {
      maxChars,
      maxChunks,
      chunkTextChars: 320,
    });
    const sourceUrl = typeof bounded.source_url === "string" && bounded.source_url.trim()
      ? bounded.source_url.trim()
      : parsed.href;
    return {
      ...bounded,
      evidence_receipts: [
        evidenceReceipt({
          producerName: "web_read",
          receiptType: "source",
          summary: "A public source page was read and bounded page evidence was returned.",
          verified: bounded.ok !== false,
          covers: ["source_verified"],
          references: urlReferences([sourceUrl]),
          satisfies: ["source_verified"],
        }),
      ],
      cache_hit: Boolean(cached),
    };
  };
}

function pageReaderBackend(value: unknown): PageReaderBackendId | undefined {
  if (
    value === "auto" ||
    value === "lightpanda" ||
    value === "lightweight" ||
    value === "jina-hosted" ||
    value === "disabled"
  ) {
    return value;
  }
  return undefined;
}

function boundedText(value: string, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: value.slice(0, Math.max(0, maxChars - 16)).trimEnd() + "\n...[truncated]",
    truncated: true,
  };
}

function boundedPageReadToolResult(result: PageReadResult, options: {
  maxChars: number;
  maxChunks: number;
  chunkTextChars: number;
}): Record<string, unknown> {
  const markdown = boundedText(result.markdown || result.text || "", options.maxChars);
  const chunkTextChars = Math.max(120, Math.min(1_500, Math.trunc(options.chunkTextChars)));
  return {
    ok: result.ok,
    reader: result.reader,
    requested_url: result.requestedUrl,
    final_url: result.finalUrl,
    source_url: result.finalUrl,
    status: result.status,
    title: result.title,
    method: result.method,
    warnings: result.warnings,
    render_recommended: result.renderRecommended,
    duration_ms: result.durationMs,
    markdown: markdown.text,
    truncated: markdown.truncated || result.chunks.length > options.maxChunks,
    chunks: result.chunks.slice(0, options.maxChunks).map((chunk) => ({
      id: chunk.id,
      index: chunk.index,
      title: chunk.title,
      url: chunk.url,
      text: boundedText(chunk.text, Math.min(chunkTextChars, options.maxChars)).text,
      char_count: chunk.charCount,
    })),
    evidence_quality: result.ok && result.text.length >= 500 && result.warnings.length === 0
      ? "good"
      : result.ok && result.text.length > 0
        ? "limited"
        : "unavailable",
    error: result.error,
  };
}
