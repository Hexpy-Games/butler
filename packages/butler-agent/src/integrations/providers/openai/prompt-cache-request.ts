import { attachmentImageDataUrl, promptWithAttachmentContext } from
  "../../../agent/context/attachment-context.ts";
import { openAIInputWithAttachments } from "../shared/runtime-support.ts";
import type {
  OpenAIAuthOverride,
  OpenAIPromptCacheConfig,
} from "../runtime-contracts.ts";
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
  authMode: OpenAIAuthOverride["mode"];
}): {
  input: unknown;
  cache: Record<string, unknown>;
  telemetry: OpenAIPromptCacheConfig;
} {
  const codexTransport = input.authMode === "codex_oauth" ||
    input.authMode === "codex_subscription";
  if (!input.boundary) {
    return {
      input: openAIInputWithAttachments(input.prompt, input.attachments),
      cache: codexTransport
        ? { ...stableKey(input.configured) }
        : { ...input.configured },
      telemetry: codexTransport ? stableKey(input.configured) : input.configured,
    };
  }
  if (input.prompt !== input.boundary.stablePrefix + input.boundary.dynamicSuffix) {
    throw new Error("OpenAI prompt cache boundary does not reconstruct the exact prompt");
  }
  if (codexTransport) {
    return {
      input: orderedInput(input.boundary, input.attachments, false),
      cache: { ...stableKey(input.configured) },
      telemetry: stableKey(input.configured),
    };
  }
  if (!EXPLICIT_BREAKPOINT_MODELS.has(input.model)) {
    return {
      input: openAIInputWithAttachments(input.prompt, input.attachments),
      cache: { ...input.configured },
      telemetry: input.configured,
    };
  }
  return {
    input: orderedInput(input.boundary, input.attachments, true),
    cache: {
      ...stableKey(input.configured),
      prompt_cache_options: { mode: "explicit" },
    },
    telemetry: stableKey(input.configured),
  };
}

function orderedInput(
  boundary: PromptCacheBoundary,
  attachments?: PromptAttachments,
  explicitBreakpoint = false,
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
        ...(explicitBreakpoint
          ? { prompt_cache_breakpoint: { mode: "explicit" } }
          : {}),
      },
      {
        type: "input_text",
        text: promptWithAttachmentContext(boundary.dynamicSuffix, attachments),
      },
      ...imageParts,
    ],
  }];
}

function stableKey(configured: OpenAIPromptCacheConfig): OpenAIPromptCacheConfig {
  return configured.prompt_cache_key
    ? { prompt_cache_key: configured.prompt_cache_key }
    : {};
}
