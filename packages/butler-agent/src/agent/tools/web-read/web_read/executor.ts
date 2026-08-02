import { readPageConfigured, type PageReaderBackendId, type PageReadResult } from "../../../../integrations/search/page-reader.ts";
import {
  browserObservationCapabilityReceipt,
  createEvidenceCapabilityReceipt,
} from "../../../output/evidence/ledger.ts";
import { evidenceReceipt, urlReferences } from "../../../tool-support/executor-support.ts";
import { publicWebReadEvidenceItems } from "../../../output/evidence/public-web-evidence.ts";

type WebReadToolCall = { args: Record<string, unknown>; signal?: AbortSignal };

export function createWebReadHandler(input: {
  butlerData: string;
  pageReader?: typeof readPageConfigured;
}): (call: WebReadToolCall) => Promise<Record<string, unknown>> {
  const pageReadCache = new Map<string, PageReadResult>();
  const modelObservationCache = new Map<string, Record<string, unknown>>();
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
    const maxChars = boundedInteger(call.args.max_chars, 1_500, 8_000, 2_000);
    const maxChunks = boundedInteger(call.args.max_chunks, 1, 8, 1);
    const startChunk = boundedInteger(
      call.args.start_chunk,
      0,
      Number.MAX_SAFE_INTEGER,
      0,
    );
    const backend = pageReaderBackend(call.args.backend);
    const readPage = input.pageReader ?? readPageConfigured;
    const cacheKey = (backend ?? "configured") + ":" + parsed.href;
    const observationCacheKey = JSON.stringify([
      cacheKey,
      startChunk,
      maxChars,
      maxChunks,
    ]);
    const duplicateObservation = modelObservationCache.get(observationCacheKey);
    if (duplicateObservation) {
      return compactDuplicateObservation(duplicateObservation);
    }
    const cached = pageReadCache.get(cacheKey);
    const result = cached ?? await readPage({
      butlerData: input.butlerData,
      url,
      backend,
      signal: call.signal,
    });
    if (!cached) pageReadCache.set(cacheKey, result);
    const bounded = boundedPageReadToolResult(result, {
      maxChars,
      maxChunks,
      startChunk,
      chunkTextChars: 320,
    });
    const sourceUrl = typeof bounded.source_url === "string" && bounded.source_url.trim()
      ? bounded.source_url.trim()
      : parsed.href;
    const capabilitySourceUrl = isHttpUrl(sourceUrl) ? sourceUrl : parsed.href;
    const hasPageEvidence = (
      typeof bounded.markdown === "string" && bounded.markdown.trim().length > 0
    ) || (
      Array.isArray(bounded.chunks) && bounded.chunks.length > 0
    );
    const sourceVerified = bounded.ok !== false &&
      bounded.evidence_quality !== "unavailable" &&
      hasPageEvidence;
    const observation = {
      ...bounded,
      public_web_evidence_items: publicWebReadEvidenceItems({
        sourceUrl: capabilitySourceUrl,
        markdown: typeof bounded.markdown === "string" ? bounded.markdown : undefined,
        chunks: Array.isArray(bounded.chunks)
          ? bounded.chunks.flatMap((chunk) => {
            const record = chunk && typeof chunk === "object" && !Array.isArray(chunk)
              ? chunk as Record<string, unknown>
              : null;
            if (!record) return [];
            return [{
              id: typeof record.id === "string" ? record.id : undefined,
              title: typeof record.title === "string" ? record.title : undefined,
              url: typeof record.url === "string" ? record.url : undefined,
              text: typeof record.text === "string" ? record.text : undefined,
            }];
          })
          : [],
        truncated: bounded.truncated === true,
        evidenceQuality: typeof bounded.evidence_quality === "string" ? bounded.evidence_quality : undefined,
        warnings: Array.isArray(bounded.warnings)
          ? bounded.warnings.filter((item): item is string => typeof item === "string")
          : [],
      }),
      evidence_capability_receipts: webReadEvidenceCapabilityReceipts({
        ok: sourceVerified,
        sourceUrl: capabilitySourceUrl,
        evidenceQuality: typeof bounded.evidence_quality === "string" ? bounded.evidence_quality : "limited",
        truncated: bounded.truncated === true,
        error: typeof bounded.error === "string" ? bounded.error : undefined,
      }).concat(webReadBrowserObservationCapabilityReceipts({
        reader: typeof bounded.reader === "string" ? bounded.reader : "",
        ok: bounded.ok !== false,
        sourceUrl: capabilitySourceUrl,
        truncated: bounded.truncated === true,
        warnings: Array.isArray(bounded.warnings) ? bounded.warnings.filter((item): item is string => typeof item === "string") : [],
      })),
      evidence_receipts: [
        evidenceReceipt({
          producerName: "web_read",
          receiptType: "source",
          summary: "A public source page was read and bounded page evidence was returned.",
          verified: sourceVerified,
          covers: ["source_verified"],
          references: urlReferences([capabilitySourceUrl]),
          satisfies: sourceVerified ? ["source_verified"] : [],
        }),
      ],
      cache_hit: Boolean(cached),
      duplicate_observation: false,
    };
    modelObservationCache.set(observationCacheKey, observation);
    return observation;
  };
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.trunc(value)))
    : fallback;
}

function compactDuplicateObservation(
  observation: Record<string, unknown>,
): Record<string, unknown> {
  const {
    markdown: _markdown,
    chunks: _chunks,
    public_web_evidence_items: _publicWebEvidenceItems,
    ...metadata
  } = observation;
  return {
    ...metadata,
    public_web_evidence_items: [],
    cache_hit: true,
    duplicate_observation: true,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function webReadBrowserObservationCapabilityReceipts(input: {
  reader: string;
  ok: boolean;
  sourceUrl: string;
  truncated: boolean;
  warnings: string[];
}) {
  if (input.reader !== "lightpanda") return [];
  return [browserObservationCapabilityReceipt({
    producer: { kind: "tool", name: "web_read" },
    result: input.ok ? "observed" : "failed",
    observation: input.ok
      ? "A browser-backed page reader observed the requested page."
      : "A browser-backed page reader did not complete the requested page observation.",
    references: [{ url: input.sourceUrl }],
    limitations: [
      input.truncated ? "Browser observation was truncated to fit runtime bounds." : "",
      ...input.warnings,
    ].filter(Boolean),
  })];
}

function webReadEvidenceCapabilityReceipts(input: {
  ok: boolean;
  sourceUrl: string;
  evidenceQuality: string;
  truncated: boolean;
  error?: string;
}) {
  if (input.ok) {
    const limitations = [
      input.evidenceQuality === "limited" ? "Page evidence is limited." : "",
      input.truncated ? "Page evidence was truncated to fit runtime bounds." : "",
    ].filter(Boolean);
    return [
      createEvidenceCapabilityReceipt({
        producer: { kind: "tool", name: "web_read" },
        capability: "source_verified",
        evidence_kind: "source_page",
        verified: true,
        confidence: input.evidenceQuality === "good" ? 0.9 : 0.7,
        summary: "A public source page was read and bounded page evidence was returned.",
        references: [{ url: input.sourceUrl }],
        satisfies: ["source_verified"],
        limitations,
      }),
    ];
  }
  return [
    createEvidenceCapabilityReceipt({
      producer: { kind: "tool", name: "web_read" },
      capability: "limitation_recorded",
      evidence_kind: "limitation",
      maturity: "rejected",
      verified: false,
      confidence: 0.2,
      summary: "A public source page read was attempted but did not produce verified page evidence.",
      references: [{ url: input.sourceUrl }],
      limitations: [input.error ?? "Source page evidence was unavailable."],
    }),
  ];
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
  startChunk: number;
  chunkTextChars: number;
}): Record<string, unknown> {
  const candidateChunks = result.chunks.slice(
    options.startChunk,
    options.startChunk + options.maxChunks,
  );
  const selectedChunks: PageReadResult["chunks"] = [];
  let completeWindowText = "";
  for (const chunk of candidateChunks) {
    const nextWindowText = completeWindowText
      ? `${completeWindowText}\n\n${chunk.text}`
      : chunk.text;
    if (nextWindowText.length > options.maxChars) break;
    selectedChunks.push(chunk);
    completeWindowText = nextWindowText;
  }
  const markdown = result.chunks.length === 0
    ? boundedText(
      options.startChunk === 0 ? result.markdown || result.text || "" : "",
      options.maxChars,
    )
    : selectedChunks.length > 0
      ? { text: completeWindowText, truncated: false }
      : candidateChunks.length > 0
        ? boundedText(candidateChunks[0]!.text, options.maxChars)
        : { text: "", truncated: false };
  const chunkTextChars = Math.max(120, Math.min(1_500, Math.trunc(options.chunkTextChars)));
  const nextStartChunk = options.startChunk + selectedChunks.length < result.chunks.length
    ? options.startChunk + selectedChunks.length
    : null;
  const contentHasMore = nextStartChunk !== null;
  const hasWindowEvidence = markdown.text.trim().length > 0 || selectedChunks.length > 0;
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
    start_chunk: options.startChunk,
    returned_chunks: selectedChunks.length,
    total_chunks: result.chunks.length,
    next_start_chunk: nextStartChunk,
    effective_max_chars: options.maxChars,
    effective_max_chunks: options.maxChunks,
    content_has_more: contentHasMore,
    markdown_truncated: markdown.truncated,
    truncated: markdown.truncated || contentHasMore,
    chunks: selectedChunks.map((chunk) => ({
      id: chunk.id,
      index: chunk.index,
      title: chunk.title,
      url: chunk.url,
      text: boundedText(chunk.text, Math.min(chunkTextChars, options.maxChars)).text,
      char_count: chunk.charCount,
    })),
    evidence_quality: !hasWindowEvidence
      ? "unavailable"
      : result.ok && result.text.length >= 500 && result.warnings.length === 0
      ? "good"
      : result.ok && result.text.length > 0
        ? "limited"
        : "unavailable",
    error: result.error,
  };
}
