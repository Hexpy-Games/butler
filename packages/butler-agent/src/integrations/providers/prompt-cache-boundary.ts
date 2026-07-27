import type { PromptOptions } from "./runtime-contracts.ts";
import type { PromptCacheBoundary } from "./contracts.ts";

export type { PromptCacheBoundary } from "./contracts.ts";

export type PromptCacheAwarePromptOptions = PromptOptions & {
  promptCacheBoundary?: PromptCacheBoundary;
};
