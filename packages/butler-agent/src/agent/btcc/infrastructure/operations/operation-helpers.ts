import { stableJson } from "../../core/index.ts";

export function parseToolInput(input: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("BTCC operation input must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BTCC operation input must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function operationContent(output: unknown): string {
  return typeof output === "string" ? output : stableJson(output);
}

export function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("BTCC operation aborted");
}

export function sameRef(
  left: { id: string; sha256: string },
  right: { id: string; sha256: string },
): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}
