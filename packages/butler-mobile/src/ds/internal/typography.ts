import type { TextStyle } from "react-native";
import type { Tokens } from "../../design/tokens";

export type TextVariant =
  | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
  | "body" | "caption" | "label"
  | "appTitle" | "panelTitle" | "sectionTitle";
export type TextTone =
  | "primary" | "secondary" | "tertiary" | "disabled" | "danger" | "success" | "warning" | "inherit";
export type WeightName = "regular" | "medium" | "semibold";

type Slug = "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "body" | "caption" | "label" | "app-title" | "panel-title" | "section-title";

const slugs: Record<TextVariant, Slug> = {
  h1: "h1", h2: "h2", h3: "h3", h4: "h4", h5: "h5", h6: "h6",
  body: "body", caption: "caption", label: "label",
  appTitle: "app-title", panelTitle: "panel-title", sectionTitle: "section-title",
};

export const toneColors = {
  primary: "--text-primary",
  secondary: "--text-secondary",
  tertiary: "--text-tertiary",
  disabled: "--color-text-disabled",
  danger: "--color-danger-text",
  success: "--color-success-text",
  warning: "--color-warning-text",
} as const;

/** Maximum dynamic-type multiplier per role. */
export const maxFontScale = { reading: 2, heading: 1.5, display: 1.3, control: 1.5, badge: 1.3 } as const;

export function variantMaxScale(variant: TextVariant): number {
  if (variant === "h1" || variant === "h2" || variant === "h3") return maxFontScale.display;
  if (variant === "body" || variant === "caption" || variant === "label" || variant === "sectionTitle") {
    return maxFontScale.reading;
  }
  return maxFontScale.heading;
}

/** Maps a weight token to the nearest embedded static Pretendard face. */
export function fontFace(weight: number): string {
  if (weight < 450) return "Pretendard-Regular";
  if (weight < 530) return "Pretendard-Medium";
  return "Pretendard-SemiBold";
}

const weightKeys = {
  regular: "--font-weight-regular",
  medium: "--font-weight-medium",
  semibold: "--font-weight-semibold",
} as const;

export function weightValue(t: Tokens, weight: WeightName): number {
  return t.number(weightKeys[weight]);
}

export function fontStyle(fontSize: number, lineHeight: number, weight: number): TextStyle {
  return { fontFamily: fontFace(weight), fontSize, lineHeight, includeFontPadding: false };
}

export function textStyle(t: Tokens, variant: TextVariant, weight?: WeightName): TextStyle {
  const s = slugs[variant];
  const value = weight ? weightValue(t, weight) : t.number(`--typo-${s}-weight`);
  return {
    ...fontStyle(t.length(`--typo-${s}-size`), t.length(`--typo-${s}-line-height`), value),
    letterSpacing: t.number(`--typo-${s}-letter-spacing`),
  };
}

/** Android has no keep-all: a WORD JOINER between a Hangul syllable and an adjacent letter/digit forbids the break (ICU LB11). */
const KEEP_ALL = /([0-9A-Za-z가-힣])(?=[가-힣])|([가-힣])(?=[0-9A-Za-z])/g;
export function keepHangulWords(text: string): string {
  return text.replace(KEEP_ALL, "$1$2\u2060");
}
