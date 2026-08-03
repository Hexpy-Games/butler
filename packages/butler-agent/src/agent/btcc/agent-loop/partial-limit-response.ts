import type { BtccAgentLoopToolResult } from "./contracts.ts";

export function renderPartialLimitResponse(
  results: BtccAgentLoopToolResult[],
): string {
  const lines = [
    "I reached the available tool budget before a complete final answer was produced.",
  ];
  if (results.length > 0) {
    lines.push("What I completed:");
    for (const result of results) {
      lines.push(`- ${result.name}: ${result.ok ? "ok" : `failed (${result.error ?? "unknown error"})`}`);
    }
  }
  lines.push("What remains: a final synthesis may need another turn.");
  return lines.join("\n");
}
