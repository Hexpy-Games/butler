import { readPageConfigured, type PageReaderBackendId } from "../../../../integrations/search/page-reader.ts";
import { createConfiguredWebSearchProvider } from "../../../../integrations/search/provider.ts";
import type { CapabilityExecutionContext } from "./contracts.ts";

type WebCapabilityName = "web_search" | "web_read";

export async function executeWebCapability(
  capability: WebCapabilityName,
  args: Record<string, unknown>,
  context: CapabilityExecutionContext,
): Promise<unknown> {
  if (capability === "web_search") {
    return createConfiguredWebSearchProvider({ butlerData: context.butlerData }).search({
      query: requireString(args.query, "query"),
      signal: context.signal,
      allowed_domains: strings(args.allowed_domains),
      blocked_domains: strings(args.blocked_domains),
      recency_days: optionalNumber(args.recency_days),
      max_results: optionalNumber(args.max_results),
    });
  }
  const result = await readPageConfigured({
    butlerData: context.butlerData,
    url: requireHttpUrl(args.url),
    backend: args.backend as PageReaderBackendId | undefined,
    signal: context.signal,
  });
  const maxChars = optionalNumber(args.max_chars) ?? 8_000;
  return {
    ...result,
    text: result.text.slice(0, maxChars),
    markdown: result.markdown.slice(0, maxChars),
    document: result.document.slice(0, maxChars),
    chunks: result.chunks.filter((chunk) => chunk.index * chunk.charCount < maxChars),
  };
}

function requireHttpUrl(value: unknown): string {
  const url = new URL(requireString(value, "url"));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_read accepts http(s) URLs only");
  }
  return url.toString();
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a string`);
  return value;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
