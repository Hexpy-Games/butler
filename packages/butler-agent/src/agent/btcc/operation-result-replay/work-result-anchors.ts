import type { ModelRoundMessage } from "../ports/model-round.ts";
import { normalizeGuidedToolCall } from "../../tools/tool-call-normalization.ts";

/** Select before replay or windowing: current Work, Plan and Review stay exact. */
export function latestWorkAnchorResults(messages: readonly ModelRoundMessage[]): ReadonlySet<ModelRoundMessage> {
  const calls = new Map(messages.flatMap((message) => (message.toolCalls ?? []).map((call) =>
    [call.id, normalizeGuidedToolCall({ toolName: call.name, args: parseRecord(call.rawArguments) ?? {} }).name] as const,
  )));
  const anchors = new Set<ModelRoundMessage>();
  for (const names of [
    new Set(["replace_work_plan"]),
    new Set(["start_work", "continue_work", "record_work_checkpoint", "record_work_review", "record_work_disposition"]),
    new Set(["record_work_review"]),
  ]) {
    const latest = messages.findLast((message) => message.role === "tool" &&
      names.has(calls.get(message.toolCallId ?? "") ?? message.name ?? "") &&
      parseRecord(message.content)?.ok === true);
    if (latest) anchors.add(latest);
  }
  return anchors;
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
