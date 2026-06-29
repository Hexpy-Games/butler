import type { ProviderModelMetadata } from "../model-catalog.ts";
import { ANTHROPIC_MODELS, ANTHROPIC_SOURCE } from "./anthropic.ts";
import { GEMINI_SOURCE, GOOGLE_MODELS } from "./google.ts";
import { KIMI_MODELS } from "./kimi.ts";
import { OPENCODE_GO_MODELS } from "./opencode-go.ts";
import { OPENAI_MODELS, OPENAI_SOURCE } from "./openai.ts";
import { QWEN_MODELS } from "./qwen.ts";
import { XAI_MODELS } from "./xai.ts";
import { ZAI_MODELS } from "./zai.ts";

export { ANTHROPIC_SOURCE, GEMINI_SOURCE, OPENAI_SOURCE };

export const HOSTED_PROVIDER_MODELS: readonly ProviderModelMetadata[] = [
  ...OPENAI_MODELS,
  ...ANTHROPIC_MODELS,
  ...GOOGLE_MODELS,
  ...XAI_MODELS,
  ...QWEN_MODELS,
  ...KIMI_MODELS,
  ...ZAI_MODELS,
  ...OPENCODE_GO_MODELS,
];
