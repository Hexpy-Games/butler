import type { ChoiceCardState } from "@/butler-ds";
import { PROVIDER_CARDS, type FirstRunProviderCardId } from "@/app/setupProviders.ts";
import type { FirstRunFlow } from "./useFirstRunFlow";

export interface ProviderCardView {
  state: ChoiceCardState;
  description: string;
  tag?: "noKey" | "local";
}

/**
 * State and description of one provider card. Offline, only models on this
 * computer can be picked; This computer with no downloaded model is dimmed.
 */
export function providerCardView(cardId: FirstRunProviderCardId, flow: FirstRunFlow, variant: "card" | "tile"): ProviderCardView {
  const { copy, local } = flow;
  const spec = PROVIDER_CARDS[cardId];
  if (spec.kind === "local") {
    if (!local.reachable) return { state: local.checking ? "loading" : "default", description: local.checking ? copy.checking : copy.localOff };
    if (local.options.length === 0) return { state: "disabled", description: copy.noModels, tag: spec.tag };
    return { state: "default", description: `${copy.localModelCount(local.options.length)} · ${local.serverNames.join(", ")}`, tag: spec.tag };
  }
  if (!flow.online) return { state: "disabled", description: variant === "card" ? copy.offlineShort : copy.offlineTile, tag: spec.tag };
  return { state: "default", description: copy.providerDescriptions[cardId], tag: spec.tag };
}
