import { View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useTokens } from "../design/useTokens";
import type { IconGlyph } from "./icons";
import { toneColors } from "./internal/typography";

export interface IconProps {
  glyph: IconGlyph;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  tone?: "primary" | "secondary" | "tertiary" | "disabled" | "danger" | "success" | "warning" | "accent";
  label?: string;
}

const sizes = {
  xs: "--icon-size-xs", sm: "--icon-size-sm", md: "--icon-size-md", lg: "--icon-size-lg", xl: "--icon-size-xl",
} as const;

export function Icon({ glyph, size = "md", tone = "primary", label }: IconProps) {
  const t = useTokens();
  const color = t.color(tone === "accent" ? "--accent-text" : toneColors[tone]);
  const hidden = label === undefined;
  return (
    <View
      accessibilityRole={hidden ? undefined : "image"}
      accessibilityLabel={label}
      accessible={hidden ? undefined : true}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? "no" : "auto"}
    >
      <HugeiconsIcon icon={glyph} size={t.length(sizes[size])} color={color} />
    </View>
  );
}
