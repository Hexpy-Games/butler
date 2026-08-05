import type { ProviderModelMetadata } from "../model-catalog.ts";
import { ANTHROPIC_MODELS, ANTHROPIC_SOURCE } from "../anthropic/catalog.ts";
import { GEMINI_SOURCE, GOOGLE_MODELS } from "../google/catalog.ts";
import { KIMI_MODELS } from "../kimi/catalog.ts";
import { OPENCODE_GO_MODELS } from "../opencode-go/catalog.ts";
import { OPENAI_MODELS, OPENAI_SOURCE } from "../openai/catalog.ts";
import { QWEN_MODELS } from "../qwen/catalog.ts";
import { XAI_MODELS } from "../xai/catalog.ts";
import { ZAI_MODELS } from "../zai/catalog.ts";
import { ZAI_API_MODELS } from "../zai-api/catalog.ts";

export { ANTHROPIC_SOURCE, GEMINI_SOURCE, OPENAI_SOURCE };

export const HOSTED_PROVIDER_MODELS: readonly ProviderModelMetadata[] = [
  ...OPENAI_MODELS,
  ...ANTHROPIC_MODELS,
  ...GOOGLE_MODELS,
  ...XAI_MODELS,
  ...QWEN_MODELS,
  ...KIMI_MODELS,
  ...ZAI_MODELS,
  ...ZAI_API_MODELS,
  ...OPENCODE_GO_MODELS,
];
