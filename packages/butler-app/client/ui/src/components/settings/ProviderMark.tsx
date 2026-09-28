import { ProviderLogo, Server } from "@/butler-ds";
import { providerLogoName } from "@/app/setupProviders.ts";

/** A model provider's logo (a local server by its platform); a neutral server icon when it has none. */
export function ProviderMark({ providerId, platform }: { providerId: string; platform?: string }) {
  const logo = providerLogoName(providerId, platform);
  return logo ? <ProviderLogo name={logo} /> : <Server size="md" />;
}
