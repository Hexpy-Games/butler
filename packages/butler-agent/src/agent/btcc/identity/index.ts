import { createHash } from "node:crypto";

export type ContentRef = { id: string; sha256: string };

export function contentRef(kind: string, body: unknown): ContentRef {
  const sha256 = digest(stableJson(body));
  return { id: digest(`btcc-${kind}.v1\0${sha256}`), sha256 };
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${canonicalEntries(value)
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("BTCC canonical JSON rejects non-finite numbers");
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("BTCC canonical JSON rejects undefined values");
  }
  return encoded;
}

function canonicalEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  const entries = Object.entries(value).map(([key, child]) => [
    key.normalize("NFC"), child,
  ] as [string, unknown]);
  const keys = new Set(entries.map(([key]) => key));
  if (keys.size !== entries.length) {
    throw new Error("BTCC canonical JSON rejects duplicate normalized keys");
  }
  return entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
