import { useId, type HTMLAttributes } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import styles from "./ProviderLogo.module.css";
import { PROVIDER_LOGO_SVGS } from "./providerLogoSvgs";

export type ProviderLogoName = keyof typeof PROVIDER_LOGO_SVGS;
export type ProviderLogoSize = "sm" | "md" | "lg";

/** Every vendored logo, in display order. */
export const PROVIDER_LOGO_NAMES = Object.keys(PROVIDER_LOGO_SVGS) as ProviderLogoName[];

export interface ProviderLogoProps
  extends Omit<DsBaseProps<HTMLAttributes<HTMLSpanElement>>, "children" | "dangerouslySetInnerHTML"> {
  /** Which service's logo. */
  name: ProviderLogoName;
  /** `sm` 14px, `md` 16px (default), `lg` 20px: the icon size scale. */
  size?: ProviderLogoSize;
  /** Accessible name. Omit when a visible label names the service (the logo is then decorative). */
  label?: string;
}

// The vendored files carry React's server id suffix on their gradient ids.
const VENDORED_ID_SUFFIX = /_R_0_/gu;

/**
 * A service logo (ChatGPT, Claude, Ollama, ...) drawn from the vendored SVG
 * files exactly as shipped: never recolored or stretched. Monochrome logos
 * paint with currentColor, so they follow the text color in light and dark.
 */
export function ProviderLogo({ name, size = "md", label, className, ...props }: ProviderLogoProps) {
  const instance = useId().replace(/[^A-Za-z0-9_-]/gu, "-");
  const logo = PROVIDER_LOGO_SVGS[name];
  return (
    <span
      {...props}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cn(styles.logo, className)}
      dangerouslySetInnerHTML={{ __html: logo.svg.replace(VENDORED_ID_SUFFIX, instance) }}
      data-name={name}
      data-size={size}
      data-slot="provider-logo"
      data-tone={logo.tone}
      role={label ? "img" : undefined}
    />
  );
}
