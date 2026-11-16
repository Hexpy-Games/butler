import { StyleSheet, Text as RNText, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useTokens } from "../design/useTokens";
import type { IconGlyph } from "./icons";
import { IconSlot } from "./internal/IconSlot";
import { AnimatedPressable, usePress } from "./internal/press";
import { fontStyle, maxFontScale, weightValue } from "./internal/typography";
import { variantColors, type ButtonVariant } from "./internal/variants";
import { SpinnerArc } from "./Spinner";

export type { ButtonVariant };

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  iconStart?: IconGlyph;
  iconEnd?: IconGlyph;
  loading?: boolean;
  disabled?: boolean;
  stretch?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

export interface IconButtonProps {
  icon: IconGlyph;
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  shape?: "default" | "pill";
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
}

export function Button({
  label, onPress, variant = "default", iconStart, iconEnd, loading, disabled, stretch,
  accessibilityLabel, accessibilityHint, testID,
}: ButtonProps) {
  const t = useTokens();
  const press = usePress({ scale: true, disabled: disabled || loading });
  const colors = variantColors(t, variant);
  const iconSize = t.length("--font-size-4");
  const lineHeight = t.length("--typo-app-title-line-height");
  const inline = t.length("--space-lg");
  const inlineIcon = t.length("--space-md");
  const glyph = (icon: IconGlyph) => (
    <IconSlot size={iconSize} lineHeight={lineHeight}>
      <HugeiconsIcon icon={icon} size={iconSize} color={colors.foreground} />
    </IconSlot>
  );
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      testID={testID}
      disabled={disabled || loading}
      onPress={onPress}
      {...press.handlers}
      style={[
        {
          minHeight: t.length("--control-hit-target"),
          paddingStart: iconStart ? inlineIcon : inline,
          paddingEnd: iconEnd ? inlineIcon : inline,
          borderRadius: t.length("--radius-control-touch"),
          borderWidth: t.length("--border-hairline"),
          borderColor: colors.border,
          backgroundColor: colors.background,
          alignItems: "center",
          justifyContent: "center",
          maxWidth: "100%",
          flexShrink: 1,
          alignSelf: stretch ? "stretch" : undefined,
          opacity: disabled ? 0.48 : press.opacity,
        },
        press.scaleStyle,
        press.focused ? { boxShadow: t.shadow("--focus-ring") } : null,
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-sm"), opacity: loading ? 0 : 1 }}>
        {iconStart ? glyph(iconStart) : null}
        <RNText
          numberOfLines={1}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={maxFontScale.control}
          style={{ ...fontStyle(iconSize, lineHeight, weightValue(t, "medium")), color: colors.foreground, flexShrink: 1 }}
        >
          {label}
        </RNText>
        {iconEnd ? glyph(iconEnd) : null}
      </View>
      {loading ? (
        <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
          <SpinnerArc size={t.length("--icon-size-lg")} color={colors.foreground} />
        </View>
      ) : null}
    </AnimatedPressable>
  );
}

export function IconButton({
  icon, label, onPress, variant = "ghost", shape = "default", loading, disabled, testID,
}: IconButtonProps) {
  const t = useTokens();
  const press = usePress({ scale: true, disabled: disabled || loading });
  const colors = variantColors(t, variant);
  const target = t.length("--control-hit-target");
  const size = t.length("--icon-size-lg");
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      testID={testID}
      disabled={disabled || loading}
      onPress={onPress}
      {...press.handlers}
      style={[
        {
          width: target,
          height: target,
          borderRadius: t.length(shape === "pill" ? "--radius-pill" : "--radius-control-touch"),
          borderWidth: t.length("--border-hairline"),
          borderColor: colors.border,
          backgroundColor: colors.background,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.48 : press.opacity,
        },
        press.scaleStyle,
        press.focused ? { boxShadow: t.shadow("--focus-ring") } : null,
      ]}
    >
      {loading ? (
        <SpinnerArc size={size} color={colors.foreground} />
      ) : (
        <HugeiconsIcon icon={icon} size={size} color={colors.foreground} />
      )}
    </AnimatedPressable>
  );
}
