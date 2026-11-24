import type { ChoiceCardState } from "@/butler-ds";
import { providerCard, providerCardDescription, type ProviderCardId } from "@/app/setupProviders.ts";
import type { FirstRunFlow } from "./useFirstRunFlow";

export interface ProviderCardView {
  state: ChoiceCardState;
  description: string;
}

/**
 * State and description of one provider card. Offline, only Other can be picked: it holds the models
 * on this computer (and servers on the local network). Other names the local models it found.
 */
export function providerCardView(cardId: ProviderCardId, flow: FirstRunFlow, variant: "card" | "tile"): ProviderCardView {
  const { copy, local } = flow;
  if (providerCard(cardId).kind === "custom") {
    const found = local.options.length > 0 ? `${copy.localModelCount(local.options.length)} · ${local.serverNames.join(", ")}` : null;
    return { state: "default", description: found ?? providerCardDescription(cardId, copy) };
  }
  if (!flow.online) return { state: "disabled", description: variant === "card" ? copy.offlineShort : copy.offlineTile };
  return { state: "default", description: providerCardDescription(cardId, copy) };
}
