import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { extname, isAbsolute, join, resolve, sep } from "path";
import type { AttachmentRef } from "../../test-support/harness/contracts.ts";

const MESSAGE_FILE_ID_PATTERN = /^file-[0-9a-f-]{36}$/iu;
const DEFAULT_MAX_ATTACHMENT_TEXT_CHARS = 24_000;
const DEFAULT_MAX_TOTAL_TEXT_CHARS = 60_000;
const MAX_ATTACHMENT_BYTES_TO_READ = 512_000;

function getButlerData(explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function safeAttachmentName(attachment: AttachmentRef, index: number): string {
  return attachment.fileName?.trim() || `attachment-${index + 1}`;
}

function attachmentFilePath(attachment: AttachmentRef, butlerData: string): string | null {
  if (MESSAGE_FILE_ID_PATTERN.test(attachment.id)) {
    return join(butlerData, "app-server", "message-files", attachment.id);
  }
  if (attachment.localPath && isAbsolute(attachment.localPath)) {
    const resolved = resolve(attachment.localPath);
    if (existsSync(resolved)) return resolved;
  }
  return null;
}

function readAttachmentBytes(attachment: AttachmentRef, butlerData: string): Buffer | null {
  const path = attachmentFilePath(attachment, butlerData);
  if (!path || !existsSync(path)) return null;
  if (MESSAGE_FILE_ID_PATTERN.test(attachment.id)) {
    const root = resolve(butlerData, "app-server", "message-files");
    const resolved = resolve(path);
    if (!resolved.startsWith(`${root}${sep}`)) return null;
  }
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES_TO_READ) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

function isTextAttachment(attachment: AttachmentRef): boolean {
  if (attachment.kind === "document") return true;
  const mime = attachment.mimeType?.toLocaleLowerCase("en-US") ?? "";
  if (mime.startsWith("text/")) return true;
  if (
    [
      "application/json",
      "application/ld+json",
      "application/markdown",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
      "application/javascript",
      "application/typescript",
    ].includes(mime)
  ) return true;
  const extension = extname(attachment.fileName ?? "").toLocaleLowerCase("en-US");
  return [
    ".md",
    ".markdown",
    ".txt",
    ".json",
    ".jsonl",
    ".yaml",
    ".yml",
    ".xml",
    ".csv",
    ".tsv",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".css",
    ".html",
  ].includes(extension);
}

function decodeUtf8(bytes: Buffer): string {
  return bytes.toString("utf8").replaceAll("\u0000", "");
}

function trimAttachmentText(text: string, maxChars: number): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  const marker = "\n[...attachment content trimmed...]\n";
  const headChars = Math.max(0, Math.floor((maxChars - marker.length) * 0.65));
  const tailChars = Math.max(0, maxChars - marker.length - headChars);
  return [
    normalized.slice(0, headChars).trimEnd(),
    marker.trim(),
    normalized.slice(Math.max(0, normalized.length - tailChars)).trimStart(),
  ].filter(Boolean).join("\n");
}

function attachmentContent(attachment: AttachmentRef, butlerData: string, maxChars: number): string | null {
  if (!isTextAttachment(attachment)) return null;
  const bytes = readAttachmentBytes(attachment, butlerData);
  if (!bytes) return null;
  const text = decodeUtf8(bytes);
  if (!text.trim()) return null;
  return trimAttachmentText(text, maxChars);
}

export function attachmentImageDataUrl(attachment: AttachmentRef, butlerData = getButlerData()): string | null {
  if (attachment.kind !== "image") return null;
  const mime = attachment.mimeType?.trim() || "";
  if (!/^image\/(?:png|jpeg|webp|gif)$/iu.test(mime)) return null;
  const bytes = readAttachmentBytes(attachment, butlerData);
  if (!bytes) return null;
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

export function renderAttachmentContext(attachments?: AttachmentRef[], options: {
  butlerData?: string;
  title?: string;
  includeTextContent?: boolean;
  maxAttachmentTextChars?: number;
  maxTotalTextChars?: number;
} = {}): string {
  const safeAttachments = (attachments ?? [])
    .filter((attachment) => attachment?.id)
    .slice(0, 12);
  if (safeAttachments.length === 0) return "";

  const butlerData = getButlerData(options.butlerData);
  const includeTextContent = options.includeTextContent !== false;
  const maxAttachmentTextChars = Math.max(0, options.maxAttachmentTextChars ?? DEFAULT_MAX_ATTACHMENT_TEXT_CHARS);
  let remainingTextChars = Math.max(0, options.maxTotalTextChars ?? DEFAULT_MAX_TOTAL_TEXT_CHARS);
  const lines = [
    `## ${options.title ?? "Attachments"}`,
    ...safeAttachments.map((attachment, index) => {
      const name = safeAttachmentName(attachment, index);
      const kind = attachment.kind || "binary";
      const mime = attachment.mimeType?.trim() || "application/octet-stream";
      const size = Number.isFinite(attachment.sizeBytes) ? `${attachment.sizeBytes} bytes` : "unknown size";
      return `- ${name} (${kind}, ${mime}, ${size}, id: ${attachment.id})`;
    }),
  ];

  if (!includeTextContent || maxAttachmentTextChars <= 0 || remainingTextChars <= 0) {
    return lines.join("\n");
  }

  safeAttachments.forEach((attachment, index) => {
    if (remainingTextChars <= 0) return;
    const perAttachmentChars = Math.min(maxAttachmentTextChars, remainingTextChars);
    const text = attachmentContent(attachment, butlerData, perAttachmentChars);
    if (!text) return;
    remainingTextChars -= text.length;
    lines.push(
      "",
      `### Attachment Content: ${safeAttachmentName(attachment, index)}`,
      `Attachment ID: ${attachment.id}`,
      "````text",
      text,
      "````",
    );
  });

  return lines.join("\n");
}

export function promptWithAttachmentContext(prompt: string, attachments?: AttachmentRef[]): string {
  const context = renderAttachmentContext(attachments);
  return context ? `${prompt}\n\n${context}` : prompt;
}
