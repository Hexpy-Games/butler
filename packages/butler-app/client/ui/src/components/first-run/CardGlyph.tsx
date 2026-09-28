import { Monitor, ProviderLogo, Server, type ProviderLogoSize } from "@/butler-ds";
import { PROVIDER_CARDS, type FirstRunProviderCardId } from "@/app/setupProviders.ts";

/** The brand logo of a card, or its neutral icon (This computer, Other). */
export function CardGlyph({ cardId, size = "lg" }: { cardId: FirstRunProviderCardId; size?: ProviderLogoSize }) {
  const spec = PROVIDER_CARDS[cardId];
  if (spec.logo) return <ProviderLogo name={spec.logo} size={size} />;
  return spec.icon === "server" ? <Server size={size} /> : <Monitor size={size} />;
}
