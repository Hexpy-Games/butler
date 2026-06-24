import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import type { AssociativeRecallResult } from "../../../cognition/memory/recall/engine.ts";

export function shouldAttemptAutomaticRecall(input: RuntimeTurnInput, text: string): boolean {
  if (!text.trim()) return false;
  if (input.metadata?.automaticRecall === false) return false;
  if (input.metadata?.transport === "system" || input.metadata?.eventKind === "system") return false;
  if (!("text" in input.input) && input.input.transport === "system") return false;
  return text.trim().length >= 4;
}

export function renderRecallContext(result: AssociativeRecallResult): string {
  if (result.abstained || result.items.length === 0) return "";
  const lines = [
    "## Associative Recall Context",
    "Use this compact memory only when it helps answer the current message. Do not expose scores unless asked.",
  ];
  for (const item of result.items.slice(0, 4)) {
    const provenance = item.provenance.slice(0, 2).join(", ");
    lines.push(
      `- ${item.summary} (confidence=${item.confidence.toFixed(2)}, ` +
        `source=${item.source}, provenance=${provenance})`,
    );
  }
  return lines.join("\n");
}
