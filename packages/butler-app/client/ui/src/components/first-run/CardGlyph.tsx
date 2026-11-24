import { ProviderLogo, Server, type ProviderLogoSize } from "@/butler-ds";
import { providerCard, providerLogoName, type ProviderCardId } from "@/app/setupProviders.ts";

/** The card provider's brand logo, or the neutral server icon (Other, or a provider without a logo). */
export function CardGlyph({ cardId, size = "lg" }: { cardId: ProviderCardId; size?: ProviderLogoSize }) {
  const logo = providerLogoName(providerCard(cardId).providerId);
  return logo ? <ProviderLogo name={logo} size={size} /> : <Server size={size} />;
}
