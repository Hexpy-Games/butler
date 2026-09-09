import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { extractPdfText } from "../../foundation/pdf-text.ts";
import type { PageReadResult } from "./page-reader.ts";

export interface PageExtractionInput {
  url: string;
  bytes: Uint8Array;
  contentType: string | null;
  status: number;
  ok: boolean;
}
export type PageExtractionResult = Omit<PageReadResult, "reader" | "requestedUrl" | "durationMs" | "renderRecommended" | "document" | "chunks">;

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
  if (result.method === "pdf" || result.method === "unsupported" || result.method === "plain-text") return false;
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

function documentKind(contentType: string | null, bytes: Uint8Array): "html" | "text" | "pdf" | "unsupported" {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime.startsWith("text/") || /^application\/(?:json|xml|javascript|typescript)$/.test(mime) || /\+(?:json|xml)$/.test(mime)) return "text";
  if (mime && mime !== "application/octet-stream" && mime !== "binary/octet-stream") return "unsupported";
  const prefix = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart();
  if (prefix.startsWith("%PDF-")) return "pdf";
  if (/^(?:<!doctype html\b|<html\b|<head\b|<body\b|<article\b)/i.test(prefix)) return "html";
  // Missing/generic MIME may still carry UTF-8 text, but never arbitrary binary.
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.trim() && !/\p{Cc}/u.test(text.replace(/[\t\r\n]/g, ""))) return "text";
  } catch {}
  return "unsupported";
}

export async function extractPageBytes(input: PageExtractionInput): Promise<PageExtractionResult> {
  const kind = documentKind(input.contentType, input.bytes);
  const base = { finalUrl: input.url, status: input.status, text: "", markdown: "", warnings: [] as string[] };
  if (kind === "unsupported") {
    return { ...base, ok: false, method: "unsupported", warnings: ["unsupported-document-type"],
      error: "Unsupported document type; its contents have not been read." };
  }
  if (kind === "pdf") {
    try {
      const pdf = await extractPdfText(input.bytes);
      return { ...base, ...pdf, markdown: pdf.text, ok: input.ok, method: "pdf" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const limitation = message.includes("scanned document") ? message
        : /password|encrypt/i.test(message)
          ? "PDF is encrypted or requires a password; its contents have not been read."
          : "PDF is damaged or unsupported; its contents have not been read.";
      return { ...base, ok: false, method: "pdf", warnings: ["pdf-text-unavailable"], error: limitation };
    }
  }
  const contentType = input.contentType;
  const attempt = { url: input.url, body: new TextDecoder().decode(input.bytes), response: input };
  if (kind === "text") {
    const text = attempt.body.trim();
    const method = new URL(input.url).hostname === "raw.githubusercontent.com" ? "github-raw" : "plain-text";
    return { ...base, text, markdown: plainTextToMarkdown(text), ok: input.ok && text.length > 0, method,
      warnings: pageWarnings({ body: attempt.body, text, contentType, method }) };
  }
  const dom = new JSDOM(attempt.body, { url: attempt.url });
  try {
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
  } finally {
    dom.window.close();
  }
}
