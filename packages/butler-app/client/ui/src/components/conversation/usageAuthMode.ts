import type { AppModelSummary, ContextDetailsView } from "@/app/types.ts";

/** How the conversation's model is billed, which picks the popover's usage section. */
export type UsageAuthMode = "subscription" | "api_key" | "local" | "unknown";

type Context = Pick<ContextDetailsView, "model_ref" | "provider_id"> | null | undefined;

export function usageAuthMode(model: AppModelSummary | null | undefined, context: Context): UsageAuthMode {
  if (model?.provider_id === "local" || model?.platform || context?.provider_id === "local") return "local";
  if (model?.auth_type === "codex_oauth") return "subscription";
  if (model?.auth_type === "api_key") return "api_key";
  return "unknown";
}

/** The catalog model the context was measured with; the active model when the context names none. */
export function contextModel(
  models: AppModelSummary[],
  context: Context,
  activeModel: AppModelSummary | null,
): AppModelSummary | null {
  if (!context?.model_ref) return activeModel;
  return models.find((model) => model.model_ref === context.model_ref) ?? null;
}
