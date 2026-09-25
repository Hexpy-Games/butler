import { localFunctionToolContractRepairPrompt } from
  "../../../integrations/providers/local/protocol.ts";
import type { BtccTextToolCallDisposition } from "./contracts.ts";

/**
 * A tool call written as text is an observation for the next round: it names
 * the tools, says nothing ran, and asks for the native tool-call format.
 */
export function textToolCallFeedback(
  names: readonly string[],
  disposition?: BtccTextToolCallDisposition,
): string {
  const detail = disposition?.status === "continue" && disposition.observation.trim()
    ? disposition.observation.trim()
    : localFunctionToolContractRepairPrompt();
  return [
    `Your previous response wrote tool call(s) as text: ${names.join(", ")}. They were not executed and produced no results.`,
    "Call tools through the native structured tool-call format, not as text, JSON, or code in your reply.",
    "",
    detail,
  ].join("\n");
}

export function uniqueTextToolCallNames(names: readonly string[] | undefined): string[] {
  return [...new Set(names ?? [])];
}
