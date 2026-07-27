import { attachmentImageDataUrl, promptWithAttachmentContext } from
  "../../../agent/context/attachment-context.ts";
import { openAIInputWithAttachments } from "../shared/runtime-support.ts";
import type { OpenAIPromptCacheConfig } from "../runtime-contracts.ts";
import type {
  PromptCacheAwarePromptOptions,
  PromptCacheBoundary,
} from "../prompt-cache-boundary.ts";

type PromptAttachments = PromptCacheAwarePromptOptions["attachments"];

const EXPLICIT_BREAKPOINT_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

export function openAIPromptCacheRequest(input: {
  model: string;
  prompt: string;
  attachments?: PromptAttachments;
  boundary?: PromptCacheBoundary;
  configured: OpenAIPromptCacheConfig;
}): {
  input: unknown;
  cache: Record<string, unknown>;
  telemetry: OpenAIPromptCacheConfig;
} {
  if (!input.boundary || !EXPLICIT_BREAKPOINT_MODELS.has(input.model)) {
    return {
      input: openAIInputWithAttachments(input.prompt, input.attachments),
      cache: { ...input.configured },
      telemetry: input.configured,
    };
  }
  if (input.prompt !== input.boundary.stablePrefix + input.boundary.dynamicSuffix) {
    throw new Error("OpenAI prompt cache boundary does not reconstruct the exact prompt");
  }
  return {
    input: cacheableInput(input.boundary, input.attachments),
    cache: {
      ...(input.configured.prompt_cache_key
        ? { prompt_cache_key: input.configured.prompt_cache_key }
        : {}),
      prompt_cache_options: { mode: "explicit" },
    },
    telemetry: input.configured.prompt_cache_key
      ? { prompt_cache_key: input.configured.prompt_cache_key }
      : {},
  };
}

function cacheableInput(
  boundary: PromptCacheBoundary,
  attachments?: PromptAttachments,
): unknown {
  const imageParts = (attachments ?? [])
    .map((attachment) => attachmentImageDataUrl(attachment))
    .filter((url): url is string => Boolean(url))
    .map((imageUrl) => ({ type: "input_image", image_url: imageUrl }));
  return [{
    role: "user",
    content: [
      {
        type: "input_text",
        text: boundary.stablePrefix,
        prompt_cache_breakpoint: { mode: "explicit" },
      },
      {
        type: "input_text",
        text: promptWithAttachmentContext(boundary.dynamicSuffix, attachments),
      },
      ...imageParts,
    ],
  }];
}
