import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deterministicClientMessageId(requestId: string): string {
  const value = digest(`authority-queue\0${requestId}`).slice(0, 32);
  return `client-${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20)}`;
}
