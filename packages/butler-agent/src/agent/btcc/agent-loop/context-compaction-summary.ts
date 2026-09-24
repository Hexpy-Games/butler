import { digest } from "../identity/index.ts";
import type { ModelRoundMessage } from "../ports/model-round.ts";
import { isContextLimitError } from "./context-capacity.ts";
import { summarizerItems, summaryPrompt } from "./context-compaction-pruning.ts";

/**
 * Summarizes once. Input is bounded by dropping the oldest items (bounded by
 * item count). A failure or empty summary returns undefined so the caller
 * falls back to deterministic pruning; it is never a user-facing error.
 */
export async function summarizeHistoryOnce(input: {
  previous: string;
  messages: readonly ModelRoundMessage[];
  maxOutputBytes: number;
  /** Byte bound for the summarizer request when the model has no sizing. */
  fallbackInputBytes: number;
  summarySizing?(): { maxBytes: number; measure(text: string): number } | undefined;
  summarize(request: { text: string; maxOutputBytes: number; sourceDigest: string }): Promise<string>;
}): Promise<string | undefined> {
  let items = summarizerItems(input.messages);
  const sizing = input.summarySizing?.() ?? {
    maxBytes: input.fallbackInputBytes, measure: (text: string) => Buffer.byteLength(text, "utf8"),
  };
  const overflows = (text: string) => sizing.measure(text) > sizing.maxBytes;
  let dropped = 0;
  while (items.length > 0 && overflows(summaryPrompt(input.previous, items))) {
    const drop = Math.max(1, Math.ceil(items.length / 4));
    items = items.slice(drop);
    dropped += drop;
  }
  for (let attempt = 0; attempt <= input.messages.length; attempt++) {
    const text = summaryPrompt(input.previous, dropped
      ? [`[${dropped} oldest items omitted from this summary input]`, ...items]
      : items);
    if (overflows(text)) return undefined;
    try {
      const summary = (await input.summarize({ text, maxOutputBytes: input.maxOutputBytes, sourceDigest: digest(text) })).trim();
      return summary || undefined;
    } catch (error) {
      if (!isContextLimitError(error) || items.length === 0) return undefined;
      const drop = Math.max(1, Math.ceil(items.length / 2));
      items = items.slice(drop);
      dropped += drop;
    }
  }
  return undefined;
}
