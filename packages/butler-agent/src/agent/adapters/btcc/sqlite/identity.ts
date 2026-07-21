import { createHash } from "node:crypto";

export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}
