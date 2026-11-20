import { useId, useMemo } from "react";
import { SvgXml } from "react-native-svg";
import { useTokens } from "../design/useTokens";
import { providerLogoXml, type ProviderLogoName } from "./internal/providerLogoXml";

export interface ProviderLogoProps { name: ProviderLogoName; size: number; label?: string }
export function ProviderLogo({ name, size, label }: ProviderLogoProps) {
  const t = useTokens();
  const instance = useId().replace(/[^A-Za-z0-9_-]/gu, "-");
  const xml = useMemo(() => providerLogoXml(name, instance), [name, instance]);
  return <SvgXml xml={xml} width={size} height={size} color={t.color("--text-primary")}
    {...(label ? { accessible: true, accessibilityRole: "image", accessibilityLabel: label } as const
      : { accessibilityElementsHidden: true, importantForAccessibility: "no" } as const)} />;
}
