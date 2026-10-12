import type { ChoiceCardState } from "@/butler-ds";
import { PROVIDER_CARDS, type FirstRunProviderCardId } from "@/app/setupProviders.ts";
import type { FirstRunFlow } from "./useFirstRunFlow";

export interface ProviderCardView {
  state: ChoiceCardState;
  description: string;
  tag?: "noKey";
}

/**
 * State and description of one provider card. Offline, only Other can be picked: it holds the models
 * on this computer (and servers on the local network). Other names the local models it found.
 */
export function providerCardView(cardId: FirstRunProviderCardId, flow: FirstRunFlow, variant: "card" | "tile"): ProviderCardView {
  const { copy, local } = flow;
  const spec = PROVIDER_CARDS[cardId];
  if (spec.kind === "custom") {
    const found = local.options.length > 0 ? `${copy.localModelCount(local.options.length)} · ${local.serverNames.join(", ")}` : null;
    return { state: "default", description: found ?? copy.providerDescriptions[cardId] };
  }
  if (!flow.online) return { state: "disabled", description: variant === "card" ? copy.offlineShort : copy.offlineTile, tag: spec.tag };
  return { state: "default", description: copy.providerDescriptions[cardId], tag: spec.tag };
}
