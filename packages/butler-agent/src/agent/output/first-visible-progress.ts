import {
  FIRST_VISIBLE_PROGRESS_FALLBACK_NOTE,
  firstVisibleProgressNote,
} from "../events/first-visible-progress.ts";
import type {
  ModelProviderAdapter,
  ModelRef,
} from "../../test-support/harness/contracts.ts";

const FIRST_VISIBLE_PROGRESS_INPUT_MAX = 1_200;
const FIRST_VISIBLE_PROGRESS_OUTPUT_MAX = 180;

export type FirstVisibleProgressGenerator = (input: {
  text: string;
  model: ModelRef;
  signal?: AbortSignal;
}) => Promise<string | null> | string | null;

export async function generateFirstVisibleProgressWithProvider(
  provider: ModelProviderAdapter,
  input: { text: string; model: ModelRef; signal?: AbortSignal },
): Promise<string | null> {
  const boundedText = input.text
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, FIRST_VISIBLE_PROGRESS_INPUT_MAX);
  if (!boundedText || input.signal?.aborted) return null;
  const result = await provider.invoke({
    model: input.model,
    reasoning: { effort: "low" },
    toolChoice: "none",
    systemPrompt: [
      "Write one short public progress sentence for the user.",
      "Return only the sentence, in the user's language.",
      "Say what you are about to orient on or check next.",
      "Do not claim you already read, searched, verified, ran, created, or saved anything.",
      "No markdown, no quotes, no hidden reasoning, no tool names, no raw paths, no secrets.",
    ].join(" "),
    messages: [{
      role: "user",
      content: `User message:\n${boundedText}`,
    }],
    metadata: {
      purpose: "app_first_visible_progress",
    },
  });
  if (input.signal?.aborted) return null;
  return safeGeneratedFirstVisibleProgress(result.text);
}

export function safeGeneratedFirstVisibleProgress(value: unknown): string | null {
  const safe = safeOptionalText(value);
  if (!safe) return null;
  const note = safe
    .replace(/^[-*]\s+/u, "")
    .replace(/^["'`]+/u, "")
    .replace(/["'`]+$/u, "")
    .replace(/^#+\s*/u, "")
    .trim();
  if (!note) return null;
  const bounded =
    note.length > FIRST_VISIBLE_PROGRESS_OUTPUT_MAX
      ? `${note.slice(0, FIRST_VISIBLE_PROGRESS_OUTPUT_MAX - 3)}...`
      : note;
  const repaired = firstVisibleProgressNote(bounded);
  if (repaired !== bounded && repaired === FIRST_VISIBLE_PROGRESS_FALLBACK_NOTE) {
    return null;
  }
  return repaired;
}

function safeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  return text || null;
}
