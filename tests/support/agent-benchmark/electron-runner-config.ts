import { createHash } from "node:crypto";

export function promptCacheKeyPrefixForPair(cachePairId: string): string {
  const digest = createHash("sha256").update(cachePairId).digest("hex").slice(0, 24);
  return `agent-benchmark-${digest}`;
}

export function electronReasoning(
  value: string | null,
): "high" | "low" | "max" | "medium" | "none" | "xhigh" | undefined {
  return value === "high" || value === "low" || value === "max" ||
      value === "medium" || value === "none" || value === "xhigh"
    ? value
    : undefined;
}
