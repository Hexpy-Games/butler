import { createHash } from "crypto";

export const PUBLIC_WEB_EVIDENCE_ITEM_SCHEMA = "butler.public-web-evidence-item.v1" as const;

export interface PublicWebEvidenceItem {
  schema_version: typeof PUBLIC_WEB_EVIDENCE_ITEM_SCHEMA;
  evidence_item_id: string;
  producer: "web_search" | "web_read";
  source_url: string;
  source_identity: string;
  observed_at: string;
  published_at: string | null;
  content_kind: "search_snippet" | "page_excerpt" | "page_chunk";
  bounded_content: string;
  limitations: string[];
}

export function publicWebSearchEvidenceItems(input: {
  observedAt?: Date;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    source: string;
    published_at?: string;
  }>;
}): PublicWebEvidenceItem[] {
  const observedAt = (input.observedAt ?? new Date()).toISOString();
  return input.results.flatMap((result) => {
    const sourceUrl = normalizedHttpUrl(result.url);
    const bounded = boundedText(
      [result.title.trim(), result.snippet.trim(), result.source.trim()].filter(Boolean).join("\n"),
      1_200,
    );
    if (!sourceUrl || !bounded.text) return [];
    return [evidenceItem({
      producer: "web_search",
      sourceUrl,
      observedAt,
      publishedAt: normalizedOptionalText(result.published_at),
      contentKind: "search_snippet",
      boundedContent: bounded.text,
      limitations: [
        "Search-result text is a provider-supplied excerpt and may omit source context.",
        ...(bounded.truncated ? ["The search-result excerpt was truncated to the evidence bound."] : []),
      ],
    })];
  });
}

export function publicWebReadEvidenceItems(input: {
  observedAt?: Date;
  sourceUrl: string;
  markdown?: string;
  chunks?: Array<{ id?: string; title?: string; url?: string; text?: string }>;
  truncated?: boolean;
  evidenceQuality?: string;
  warnings?: string[];
}): PublicWebEvidenceItem[] {
  const observedAt = (input.observedAt ?? new Date()).toISOString();
  const fallbackUrl = normalizedHttpUrl(input.sourceUrl);
  if (!fallbackUrl) return [];
  const sharedLimitations = [
    ...(input.evidenceQuality === "limited" ? ["The page reader classified this evidence as limited."] : []),
    ...(input.truncated ? ["The page evidence was truncated to the configured read bound."] : []),
    ...(input.warnings ?? []).map((warning) => warning.trim()).filter(Boolean).slice(0, 4),
  ];
  const chunks = (input.chunks ?? []).flatMap((chunk) => {
    const sourceUrl = normalizedHttpUrl(chunk.url ?? "") ?? fallbackUrl;
    const bounded = boundedText(
      [chunk.title?.trim(), chunk.text?.trim()].filter(Boolean).join("\n"),
      1_500,
    );
    if (!bounded.text) return [];
    return [evidenceItem({
      producer: "web_read",
      sourceUrl,
      observedAt,
      publishedAt: null,
      contentKind: "page_chunk",
      boundedContent: bounded.text,
      limitations: [
        ...sharedLimitations,
        ...(bounded.truncated ? ["The page chunk was truncated to the evidence bound."] : []),
      ],
    })];
  });
  if (chunks.length > 0) return uniqueEvidenceItems(chunks).slice(0, 8);
  const bounded = boundedText(input.markdown?.trim() ?? "", 4_000);
  if (!bounded.text) return [];
  return [evidenceItem({
    producer: "web_read",
    sourceUrl: fallbackUrl,
    observedAt,
    publishedAt: null,
    contentKind: "page_excerpt",
    boundedContent: bounded.text,
    limitations: [
      ...sharedLimitations,
      ...(bounded.truncated ? ["The page excerpt was truncated to the evidence bound."] : []),
    ],
  })];
}

export function isPublicWebEvidenceItem(value: unknown): value is PublicWebEvidenceItem {
  const item = recordValue(value);
  return item?.schema_version === PUBLIC_WEB_EVIDENCE_ITEM_SCHEMA &&
    typeof item.evidence_item_id === "string" && item.evidence_item_id.length > 0 &&
    (item.producer === "web_search" || item.producer === "web_read") &&
    typeof item.source_url === "string" && normalizedHttpUrl(item.source_url) === item.source_url &&
    typeof item.source_identity === "string" && item.source_identity === sourceIdentity(item.source_url) &&
    typeof item.observed_at === "string" && !Number.isNaN(Date.parse(item.observed_at)) &&
    (item.published_at === null || typeof item.published_at === "string") &&
    new Set(["search_snippet", "page_excerpt", "page_chunk"]).has(String(item.content_kind)) &&
    typeof item.bounded_content === "string" && item.bounded_content.trim().length > 0 &&
    Array.isArray(item.limitations) && item.limitations.every((entry) => typeof entry === "string") &&
    item.evidence_item_id === evidenceItemId({
      producer: item.producer,
      sourceUrl: item.source_url,
      contentKind: item.content_kind as PublicWebEvidenceItem["content_kind"],
      boundedContent: item.bounded_content,
    });
}

function evidenceItem(input: {
  producer: PublicWebEvidenceItem["producer"];
  sourceUrl: string;
  observedAt: string;
  publishedAt: string | null;
  contentKind: PublicWebEvidenceItem["content_kind"];
  boundedContent: string;
  limitations: string[];
}): PublicWebEvidenceItem {
  return {
    schema_version: PUBLIC_WEB_EVIDENCE_ITEM_SCHEMA,
    evidence_item_id: evidenceItemId(input),
    producer: input.producer,
    source_url: input.sourceUrl,
    source_identity: sourceIdentity(input.sourceUrl),
    observed_at: input.observedAt,
    published_at: input.publishedAt,
    content_kind: input.contentKind,
    bounded_content: input.boundedContent,
    limitations: [...new Set(input.limitations.filter(Boolean))],
  };
}

function evidenceItemId(input: {
  producer: string;
  sourceUrl: string;
  contentKind: string;
  boundedContent: string;
}): string {
  return `public-web-${createHash("sha256")
    .update(`${input.producer}\n${input.sourceUrl}\n${input.contentKind}\n${input.boundedContent}`)
    .digest("hex").slice(0, 24)}`;
}

function sourceIdentity(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return "";
  }
}

function normalizedHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function normalizedOptionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedText(value: string, maxChars: number): { text: string; truncated: boolean } {
  const text = value.trim();
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars - 16).trimEnd()}\n...[truncated]`, truncated: true };
}

function uniqueEvidenceItems(items: PublicWebEvidenceItem[]): PublicWebEvidenceItem[] {
  return [...new Map(items.map((item) => [item.evidence_item_id, item])).values()];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
