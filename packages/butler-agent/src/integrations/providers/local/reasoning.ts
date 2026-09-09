import type { ReasoningEffort } from "../model-catalog.ts";
import type { LocalModelConfig } from "./models.ts";

// Qwen3.8's chat template accepts these named efforts, independently of a token budget.
// Keep unknown local models on their existing protocol instead of assuming API parity.
export function localNativeReasoningEfforts(model: LocalModelConfig): ReasoningEffort[] | null {
  return /(?:^|\/)qwen3\.8(?:$|[-:])/iu.test(model.model_id)
    ? ["none", "low", "medium", "xhigh"]
    : null;
}
