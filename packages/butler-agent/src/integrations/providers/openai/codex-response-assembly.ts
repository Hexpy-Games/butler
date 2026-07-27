import type { CodexSseAccumulator, OpenAIResponse } from "../runtime-contracts.ts";

export function codexSseResponseFromAccumulator(
  accumulator: CodexSseAccumulator,
): OpenAIResponse {
  if (accumulator.output.length === 0 && Array.isArray(accumulator.completed?.output)) {
    accumulator.output.push(...accumulator.completed.output);
  }

  const usage = accumulator.completed?.usage;
  return {
    id: typeof accumulator.completed?.id === "string"
      ? accumulator.completed.id
      : `codex-${Date.now()}`,
    output: accumulator.output,
    output_text: hasCompletedText(accumulator.output)
      ? undefined
      : accumulator.fallbackText || undefined,
    usage: usage
      ? {
          input_tokens: usage.input_tokens,
          prompt_tokens: usage.input_tokens,
          total_tokens: usage.total_tokens,
          prompt_tokens_details: {
            cached_tokens: usage.input_tokens_details?.cached_tokens,
            cache_write_tokens: usage.input_tokens_details?.cache_write_tokens,
          },
        }
      : undefined,
  };
}

function hasCompletedText(output: OpenAIResponse["output"]): boolean {
  return (output ?? []).some((item) => {
    if ((item?.type === "output_text" || item?.type === "text") && typeof item.text === "string") {
      return true;
    }
    return item?.type === "message" && Array.isArray(item.content) && item.content.some(
      (content: Record<string, unknown>) =>
        (content.type === "output_text" || content.type === "text") &&
        typeof content.text === "string",
    );
  });
}
