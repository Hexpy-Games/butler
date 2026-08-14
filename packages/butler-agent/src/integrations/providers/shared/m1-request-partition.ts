import { Buffer } from "node:buffer";
import type {
  M1RequestSegmentKind,
  M1ProviderRequestSegmentManifestEntry,
  M1SegmentStability,
} from "../../../agent/btcc/ports/provider-request-attribution.ts";

export function serializeM1RequestPartition(
  body: Record<string, unknown>,
  manifest: readonly M1ProviderRequestSegmentManifestEntry[] = [],
): {
  serialized: string;
  parts: Map<string, { bytes: number; serializedFragments: string[] }>;
} {
  const parts = new Map<string, { bytes: number; serializedFragments: string[] }>();
  let serialized = "";
  const append = (fragment: string, kind: M1RequestSegmentKind, stability: M1SegmentStability) => {
    serialized += fragment;
    const identity = `${kind}\u0000${stability}`;
    const part = parts.get(identity) ?? { bytes: 0, serializedFragments: [] };
    part.bytes += Buffer.byteLength(fragment, "utf8");
    part.serializedFragments.push(fragment);
    parts.set(identity, part);
  };
  const carrier = (fragment: string) => append(fragment, "provider_carrier_overhead", "dynamic");

  const write = (value: unknown, path: readonly (string | number)[], inherited?: M1RequestSegmentKind): void => {
    if (typeof value === "string") {
      if (isProviderStructuralString(path)) {
        carrier(JSON.stringify(value));
        return;
      }
      const entries = manifest.filter((entry) => samePath(entry.path, path));
      if (entries.length > 0) {
        carrier('"');
        let utf16Offset = 0;
        for (const codePoint of value) {
          const source = entryAtOffset(entries, utf16Offset, value.length);
          append(
            JSON.stringify(codePoint).slice(1, -1),
            source?.kind ?? "other_typed_context",
            source?.stability ?? "dynamic",
          );
          utf16Offset += codePoint.length;
        }
        carrier('"');
        return;
      }
      append(JSON.stringify(value), inherited ?? defaultKind(path, value), defaultStability(path));
      return;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      append(JSON.stringify(value), inherited ?? defaultKind(path, value), defaultStability(path));
      return;
    }
    if (Array.isArray(value)) {
      carrier("[");
      value.forEach((child, index) => {
        if (index > 0) carrier(",");
        write(child, [...path, index], inherited ?? inheritedKind(path, child));
      });
      carrier("]");
      return;
    }
    if (value && typeof value === "object") {
      carrier("{");
      const entries = Object.entries(value).filter(([, child]) =>
        child !== undefined && typeof child !== "function" && typeof child !== "symbol",
      );
      entries.forEach(([key, child], index) => {
        if (index > 0) carrier(",");
        carrier(`${JSON.stringify(key)}:`);
        const nextPath = [...path, key];
        write(child, nextPath, inherited ?? inheritedKind(nextPath, child));
      });
      carrier("}");
      return;
    }
    carrier("null");
  };
  write(body, []);
  const canonical = JSON.stringify(body);
  if (serialized !== canonical) {
    return {
      serialized: canonical,
      parts: new Map([["other_typed_context\u0000dynamic", {
        bytes: Buffer.byteLength(canonical, "utf8"),
        serializedFragments: [canonical],
      }]]),
    };
  }
  return { serialized, parts };
}

function isProviderStructuralString(path: readonly (string | number)[]): boolean {
  const field = path.at(-1);
  return field === "role" || field === "type" || field === "call_id";
}

function entryAtOffset(
  entries: readonly M1ProviderRequestSegmentManifestEntry[],
  offset: number,
  valueLength: number,
): M1ProviderRequestSegmentManifestEntry | undefined {
  for (const entry of entries) {
    const start = entry.startUtf16 ?? 0;
    const end = entry.endUtf16 ?? valueLength;
    if (offset >= start && offset < end) return entry;
  }
  return undefined;
}

function samePath(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function inheritedKind(
  path: readonly (string | number)[],
  value: unknown,
): M1RequestSegmentKind | undefined {
  if (path[0] === "tools") return "tool_schema";
  if (path[0] === "instructions") return "stable_safety_and_role_instructions";
  if (path[0] !== "input") return undefined;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "function_call_output") return "latest_tool_result_delivery";
    if (record.type === "function_call") return "other_typed_context";
    if (record.type === "input_image" || record.image_url !== undefined) return "source_reference";
  }
  return undefined;
}

function defaultKind(path: readonly (string | number)[], value: unknown): M1RequestSegmentKind {
  if (path[0] === "tools") return "tool_schema";
  if (path[0] === "instructions") return "stable_safety_and_role_instructions";
  if (path[0] === "input") {
    if (path.includes("image_url")) return "source_reference";
    return "other_typed_context";
  }
  return typeof value === "string" ? "other_typed_context" : "provider_carrier_overhead";
}

function defaultStability(path: readonly (string | number)[]): M1SegmentStability {
  return path[0] === "instructions" || path[0] === "tools" ? "stable" : "dynamic";
}
