import { stableJson } from "../../core/index.ts";

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
