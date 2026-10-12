import { ProviderLogo, Server, type ProviderLogoSize } from "@/butler-ds";
import { PROVIDER_CARDS, type FirstRunProviderCardId } from "@/app/setupProviders.ts";

/** The brand logo of a card, or the neutral server icon (Other). */
export function CardGlyph({ cardId, size = "lg" }: { cardId: FirstRunProviderCardId; size?: ProviderLogoSize }) {
  const spec = PROVIDER_CARDS[cardId];
  if (spec.logo) return <ProviderLogo name={spec.logo} size={size} />;
  return <Server size={size} />;
}
