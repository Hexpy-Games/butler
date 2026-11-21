import React from "react";
import { StyleSheet, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { PILL } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { BaseText } from "./internal/BaseText";
import type { IconGlyph } from "./icons";
import { IconSlot } from "./internal/IconSlot";
import { AnimatedPressable, usePress } from "./internal/press";
import { fontStyle, maxFontScale, textStyle, weightValue } from "./internal/typography";
import { variantColors, type ButtonVariant } from "./internal/variants";
import { SpinnerArc } from "./Spinner";

export type { ButtonVariant };

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: "md" | "sm";
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
  icon: IconGlyph | React.ReactElement;
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: "md" | "sm" | "control";
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
}

export function Button({
  label, onPress, variant = "default", size = "md", iconStart, iconEnd, loading, disabled, stretch,
  accessibilityLabel, accessibilityHint, testID,
}: ButtonProps) {
  const t = useTokens();
  const press = usePress({ scale: true, disabled: disabled || loading });
  const colors = variantColors(t, variant);
  const target = t.length("--control-hit-target");
  const height = size === "sm" ? t.length("--control-height-sm") : target;
  const hitSlop = Math.max(0, (target - height) / 2);
  const iconSize = t.length(size === "sm" ? "--icon-size-md" : "--font-size-4");
  const lineHeight = t.length(size === "sm" ? "--typo-caption-line-height" : "--typo-app-title-line-height");
  const labelStyle = size === "sm" ? textStyle(t, "caption", "medium") : fontStyle(iconSize, lineHeight, weightValue(t, "medium"));
  const inline = t.length(size === "sm" ? "--space-3" : "--space-lg");
  const inlineIcon = t.length(size === "sm" ? "--space-2" : "--space-md");
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
      hitSlop={size === "sm" ? { top: hitSlop, bottom: hitSlop, left: t.length("--space-1"), right: t.length("--space-1") } : undefined}
      testID={testID}
      disabled={disabled || loading}
      onPress={onPress}
      {...press.handlers}
      style={[
        {
          minHeight: height,
          paddingVertical: (height - lineHeight) / 2 - (size === "sm" ? t.length("--border-hairline") : 0),
          paddingStart: iconStart ? inlineIcon : inline,
          paddingEnd: iconEnd ? inlineIcon : inline,
          borderRadius: t.length(PILL),
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
        <BaseText
          numberOfLines={1}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={maxFontScale.control}
          style={{ ...labelStyle, color: colors.foreground, flexShrink: 1 }}
        >
          {label}
        </BaseText>
        {iconEnd ? glyph(iconEnd) : null}
      </View>
      {loading ? (
        <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
          <SpinnerArc size={size === "sm" ? iconSize : t.length("--icon-size-lg")} color={colors.foreground} />
        </View>
      ) : null}
    </AnimatedPressable>
  );
}

export function IconButton({
  icon, label, onPress, variant = "ghost", size = "md", loading, disabled, testID,
}: IconButtonProps) {
  const t = useTokens();
  const press = usePress({ scale: true, disabled: disabled || loading });
  const colors = variantColors(t, variant);
  const target = t.length("--control-hit-target");
  const box = size === "control" ? t.length("--control-height-lg") : size === "sm" ? t.length("--control-height-sm") : target;
  const iconSize = t.length(size === "sm" ? "--icon-size-md" : "--icon-size-lg");
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      hitSlop={size === "md" ? undefined : (target - box) / 2}
      testID={testID}
      disabled={disabled || loading}
      onPress={onPress}
      {...press.handlers}
      style={[
        {
          width: box,
          height: box,
          borderRadius: t.length(PILL),
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
        <SpinnerArc size={iconSize} color={colors.foreground} />
      ) : (
        React.isValidElement(icon) ? icon : <HugeiconsIcon icon={icon} size={iconSize} color={colors.foreground} />
      )}
    </AnimatedPressable>
  );
}
