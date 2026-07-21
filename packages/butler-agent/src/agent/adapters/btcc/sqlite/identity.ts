import { createHash } from "node:crypto";

export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("BTCC canonical JSON rejects non-finite numbers");
  }
  if (value === undefined) throw new Error("BTCC canonical JSON rejects undefined values");
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key.normalize("NFC"), normalize(child),
    ] as const);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
      throw new Error("BTCC canonical JSON rejects duplicate normalized keys");
    }
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return Object.fromEntries(entries);
  }
  return value;
}
