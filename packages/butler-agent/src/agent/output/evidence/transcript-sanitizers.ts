import { sanitizePublicText } from "../../events/turn-events.ts";

const MAX_SAFE_ARGUMENT_KEYS = 24;
const MAX_SAFE_OBJECT_ENTRIES = 16;
const MAX_SAFE_ARRAY_ITEMS = 12;
const MAX_SAFE_VALUE_DEPTH = 2;
const MAX_SAFE_PUBLIC_TEXT_VALUES = 8;
const SAFE_PUBLIC_TEXT_MAX_CHARS = 320;
const SAFE_OPTIONAL_PUBLIC_TEXT_MAX_CHARS = 240;
const SAFE_IDENTIFIER_MAX_CHARS = 120;

export function safeToolArgumentRecord(args: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args).slice(0, MAX_SAFE_ARGUMENT_KEYS)) {
    safe[safeIdentifier(key, "argument")] = safeToolArgumentValue(key, value, 0);
  }
  return safe;
}

export function safeToolArgumentKeys(args: Record<string, unknown>): string[] {
  return Object.keys(args)
    .map((key) => safeIdentifier(key, "argument"))
    .slice(0, MAX_SAFE_ARGUMENT_KEYS);
}

export function safePublicTextArray(values: string[]): string[] {
  return values
    .map((value) => safeOptionalPublicText(value))
    .filter((value): value is string => Boolean(value))
    .slice(0, MAX_SAFE_PUBLIC_TEXT_VALUES);
}

export function safePublicText(value: unknown, fallback: string): string {
  const stripped = stripHiddenReasoning(typeof value === "string" ? value : "");
  const sanitized = sanitizePublicText(stripped, fallback).trim();
  if (!sanitized || hasPrivateOrSecretSentinel(sanitized)) {
    return fallback;
  }
  return sanitized.slice(0, SAFE_PUBLIC_TEXT_MAX_CHARS);
}

export function safeOptionalPublicText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const safe = safePublicText(value, "");
  if (!safe) {
    return null;
  }
  return safe.slice(0, SAFE_OPTIONAL_PUBLIC_TEXT_MAX_CHARS);
}

export function safeIdentifier(value: unknown, fallback: string): string {
  const safe = safeOptionalPublicText(value);
  return safe?.replace(/\s+/gu, "-").slice(0, SAFE_IDENTIFIER_MAX_CHARS) || fallback;
}

export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = new URL(value.trim());
    const isPublicWebProtocol = parsed.protocol === "http:" || parsed.protocol === "https:";
    if (!isPublicWebProtocol) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function safeRelativePath(value: unknown): string | null {
  const text = safeOptionalPublicText(value);
  if (!text) {
    return null;
  }
  if (
    text.startsWith("/") ||
    text.startsWith("~") ||
    /^[A-Za-z]:[\\/]/u.test(text) ||
    text.split(/[\\/]+/u).includes("..")
  ) {
    return null;
  }
  return text;
}

function safeToolArgumentValue(key: string, value: unknown, depth: number): unknown {
  if (isSensitiveKey(key)) {
    return "[redacted]";
  }
  if (depth > MAX_SAFE_VALUE_DEPTH) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return safePublicText(value, "[redacted]");
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_SAFE_ARRAY_ITEMS)
      .map((item) => safeToolArgumentValue(key, item, depth + 1));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const [key, childValue] of Object.entries(record).slice(0, MAX_SAFE_OBJECT_ENTRIES)) {
      safe[safeIdentifier(key, "field")] = safeToolArgumentValue(key, childValue, depth + 1);
    }
    return safe;
  }
  return null;
}

function isSensitiveKey(key: string): boolean {
  return /\b(?:api[_-]?key|token|secret|password|passphrase|authorization|auth|credential|credentials|access[_-]?token|refresh[_-]?token|private[_-]?key|session[_-]?key|cookie|set-cookie)\b/iu
    .test(key);
}

function stripHiddenReasoning(value: string): string {
  return value.replace(/<think\b[^>]*>[\s\S]*?<\/think>/giu, "")
    .replace(/<\/?think\b[^>]*>/giu, "");
}

function hasPrivateOrSecretSentinel(value: string): boolean {
  return (
    /SECRET[_-]?TOKEN/iu.test(value) ||
    /raw prompt text/iu.test(value) ||
    /<think\b|<\/think>/iu.test(value) ||
    /\/Users\/private\b/u.test(value) ||
    /(?:api[_-]?key|secret|token|authorization|bearer)\s*[:=]/iu.test(value)
  );
}
