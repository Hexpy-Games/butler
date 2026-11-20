import { PROVIDER_LOGO_SVGS, VENDORED_VIEWBOX } from "../../../../butler-app/client/ui/src/libs/design-system/components/ProviderLogo/providerLogoSvgs.ts";
export type ProviderLogoName = keyof typeof PROVIDER_LOGO_SVGS;
/** The vendored SVG fitted to the icon grid (desktop ProviderLogo), with per-instance gradient ids and no web-only root attributes. */
export function providerLogoXml(name: ProviderLogoName, instance: string): string {
  const logo = PROVIDER_LOGO_SVGS[name];
  return logo.svg.replace(/_R_0_/gu, instance).replace(VENDORED_VIEWBOX, `viewBox="${logo.fit}"`)
    .replace(/ style="[^"]*"/u, "").replace(/ (?:width|height)="1em"/gu, "");
}
