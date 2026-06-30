import { Buffer } from "node:buffer";

const SAFE_TEXT_MAX = 240;

export function isPublicTextSafe(value: unknown): boolean {
  return sanitizePublicText(value, "") === String(value ?? "").trim().slice(0, SAFE_TEXT_MAX);
}

export function sanitizePublicText(value: unknown, fallback = "Working"): string {
  const raw = typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
  const normalized = stripControlCharacters(raw)
    .replace(secretAssignmentPattern(), "[redacted]")
    .replace(/\bbearer\s+[\w.~+/=-]+/giu, "Bearer [redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return fallback;
  if (looksPrivateOrInternal(normalized)) return fallback;
  return normalized.slice(0, SAFE_TEXT_MAX);
}

function looksPrivateOrInternal(value: string): boolean {
  if (looksPrivateOrInternalText(value)) return true;
  const decoded = decodeBase64Candidate(value);
  return Boolean(decoded && looksPrivateOrInternalText(decoded));
}

function looksPrivateOrInternalText(value: string): boolean {
  return /<\s*\/?\s*(?:think|thinking|reasoning)\b[^>]*>/iu.test(value) ||
    /<\|?(?:channel|start|message|assistant|analysis|final)[^>]*\|?>/i.test(value) ||
    /\b(?:hidden reasoning|chain[- ]of[- ]thought|scratchpad|internal plan|let me think|let's think|i need to think|we need to think|step[- ]by[- ]step reasoning)\b/iu.test(value) ||
    /\b(?:tool_call|tool_result|argumentsJson|raw transcript|sessionId|eventId|FileNotFoundException|root_path|butler-workers|ENOENT)\b/u.test(value) ||
    /(?:^|[\s"'`:=])\/(?:Users|private|tmp|var\/folders|home|Volumes|opt|usr|etc)\b/u.test(value) ||
    /(?:^|[\s"'`:=])(?:[A-Za-z]:\\|\\\\[^\s\\]+\\[^\s\\]+)/u.test(value) ||
    /^\s*[{[]/u.test(value) && /"(?:eventId|sessionId|payload|arguments|tool_call)"/u.test(value);
}

function decodeBase64Candidate(value: string): string | null {
  const compact = value.replace(/\s+/gu, "");
  if (compact.length < 24 || compact.length > 2_048) return null;
  if (!/^[A-Za-z0-9+/=_-]+$/u.test(compact)) return null;
  try {
    const normalized = compact.replace(/-/gu, "+").replace(/_/gu, "/");
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    if (!decoded || decoded.includes("\uFFFD")) return null;
    return decoded;
  } catch {
    return null;
  }
}

function secretAssignmentPattern(): RegExp {
  return /\b(?:api[_-]?key|token|secret|password|database_url|db_url)\s*[:=]\s*\S+|\b(?:auth|authorization)\s*[:=]\s*(?:bearer\s+)?\S+/giu;
}

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
}
