import type { ModelProviderAdapter, ModelRef } from "../../test-support/harness/contracts.ts";

export type SessionTitleGenerator = (input: {
  text: string;
  model: ModelRef;
  signal?: AbortSignal;
}) => Promise<string | null> | string | null;

export async function generateSessionTitleWithProvider(
  provider: ModelProviderAdapter,
  input: { text: string; model: ModelRef; signal?: AbortSignal },
): Promise<string | null> {
  const boundedText = input.text.replace(/\s+/gu, " ").trim().slice(0, 1200);
  if (!boundedText || input.signal?.aborted) return null;
  const result = await provider.invoke({
    model: input.model,
    systemPrompt: [
      "Generate one safe chat session title.",
      "Return only the title, in the user's language.",
      "Keep it concise: normally 2 to 8 words, no quotes, no markdown, no trailing period.",
      "Do not include secrets, raw prompts, tool names, or internal ids.",
    ].join(" "),
    messages: [{
      role: "user",
      content: `User message:\n${boundedText}`,
    }],
    metadata: {
      purpose: "app_session_title",
    },
  });
  if (input.signal?.aborted) return null;
  return safeGeneratedSessionTitle(result.text);
}

export function normalizeModelRef(value?: string): ModelRef {
  const trimmed = value?.trim();
  if (trimmed && trimmed.includes("/")) return trimmed as ModelRef;
  if (trimmed) return `openai/${trimmed}`;
  return "openai/gpt-5.6-sol";
}

export function safeGeneratedSessionTitle(value: unknown): string | null {
  const safe = safeOptionalText(value);
  if (!safe) return null;
  const title = safe
    .replace(/^["'`]+/u, "")
    .replace(/["'`.]+$/u, "")
    .replace(/^#+\s*/u, "")
    .trim();
  if (!title) return null;
  return title.length > 64 ? `${title.slice(0, 61)}...` : title;
}

function safeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  return text || null;
}
