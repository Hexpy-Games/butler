import { ProviderLogo, Server } from "@/butler-ds";
import { providerLogoName } from "@/app/setupProviders.ts";

/**
 * A model provider's logo (a local server by its platform); a neutral server icon when it has none.
 * `besideProviderName` when the label is the provider's name rather than a model's.
 */
export function ProviderMark({ providerId, platform, besideProviderName }: { providerId: string; platform?: string; besideProviderName?: boolean }) {
  const logo = providerLogoName(providerId, platform, besideProviderName);
  return logo ? <ProviderLogo name={logo} /> : <Server size="md" />;
}
