import type { TextStyle } from "react-native";
import { useTokens } from "../design/useTokens";
import { BaseText } from "./internal/BaseText";
import { textStyle, toneColors, variantMaxScale, type TextTone, type TextVariant, type WeightName } from "./internal/typography";

export type { TextTone, TextVariant };

export interface TextProps {
  children: React.ReactNode;
  variant?: TextVariant;
  tone?: TextTone;
  weight?: WeightName;
  align?: "start" | "center" | "end";
  lines?: 1 | 2 | 3 | 4 | 5;
  numeric?: "tabular";
  literal?: boolean;
  selectable?: boolean;
  accessibilityLabel?: string;
}

const headings = new Set<TextVariant>(["h1", "h2", "h3", "h4", "h5", "h6", "appTitle", "panelTitle"]);
const aligns = { start: "left", center: "center", end: "right" } as const;

export function Text({
  children, variant = "body", tone = "primary", weight, align, lines, numeric, literal, selectable, accessibilityLabel,
}: TextProps) {
  const t = useTokens();
  const heading = headings.has(variant);
  const fontVariant: TextStyle["fontVariant"] = [
    ...(numeric ? (["tabular-nums"] as const) : []),
    ...(literal ? (["no-common-ligatures", "no-contextual"] as const) : []),
  ];
  const style: TextStyle = {
    ...textStyle(t, variant, weight),
    ...(tone === "inherit" ? null : { color: t.color(toneColors[tone]) }),
    ...(align ? { textAlign: aligns[align] } : null),
    ...(fontVariant.length ? { fontVariant } : null),
  };
  return (
    <BaseText
      style={style}
      numberOfLines={lines}
      ellipsizeMode="tail"
      selectable={selectable}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={heading ? "header" : undefined}
      maxFontSizeMultiplier={variantMaxScale(variant)}
    >
      {children}
    </BaseText>
  );
}
