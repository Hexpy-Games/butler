import { basename } from "node:path";
import type { MessageFileKind } from "./protocol.ts";

export const MESSAGE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const MESSAGE_FILE_MAX_ATTACHMENTS = 12;
export const MESSAGE_FILE_ID_PATTERN = /^file-[0-9a-f-]{36}$/iu;

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export function normalizeFileBytes(
  bytes: Uint8Array | ArrayBuffer | string,
): Buffer {
  if (typeof bytes === "string") return Buffer.from(bytes, "utf8");
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function safeAttachmentName(name: string): string {
  const pathFreeName =
    (name || "attachment")
      .split(/[\\/]+/u)
      .filter(Boolean)
      .pop() ?? "attachment";
  const base = basename(pathFreeName)
    .replace(/[^\p{L}\p{N}_ .@()+\-[\]]+/gu, "_")
    .trim();
  const normalized =
    base && base !== "." && base !== ".." ? base : "attachment";
  return normalized.slice(0, 120);
}

export function normalizeAttachmentMimeType(
  mimeType: string | undefined,
  safeName: string,
): string {
  const value =
    mimeType?.split(";")[0]?.trim().toLocaleLowerCase("en-US") ?? "";
  if (value) return value;
  const lower = safeName.toLocaleLowerCase("en-US");
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".json")) return "application/json";
  if (isTextLikeAttachmentName(lower)) return "text/plain";
  return "application/octet-stream";
}

export function classifyMessageFileKind(
  mimeType: string,
  safeName: string,
  allowGeneric: boolean,
): MessageFileKind | null {
  if (SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) return "image";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    isTextLikeAttachmentName(safeName)
  ) {
    return "text";
  }
  return allowGeneric ? "generic" : null;
}

export function messageFileContentKey(
  safeName: string,
  mimeType: string,
  sizeBytes: number,
  sha256: string,
): string {
  return `${safeName}\u0000${mimeType}\u0000${sizeBytes}\u0000${sha256}`;
}

export function mimeTypeForArtifactPath(path: string): string {
  const lower = path.toLocaleLowerCase("en-US");
  if (lower.endsWith(".md") || lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function isTextLikeAttachmentName(name: string): boolean {
  return /\.(?:txt|md|markdown|json|ya?ml|jsx?|tsx?|css|html?|xml|csv|log|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|sh|zsh|toml|ini)$/iu.test(
    name,
  );
}
