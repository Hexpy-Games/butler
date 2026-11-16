import { useEffect, useRef, useState } from "react";
import { Animated, Text as RNText, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { alpha } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import type { IconGlyph } from "./icons";
import { run, useReducedMotion } from "./internal/motion";
import { fontStyle, maxFontScale, weightValue } from "./internal/typography";

export interface BadgeProps {
  label: string;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  icon?: IconGlyph;
}
export interface UnreadDotProps { label: string; present?: boolean }

export function Badge({ label, tone = "neutral", icon }: BadgeProps) {
  const t = useTokens();
  const colors = {
    neutral: { border: t.color("--line"), fill: t.color("--surface"), text: t.color("--text-secondary") },
    accent: { border: alpha(t.color("--accent"), 0.36), fill: t.color("--surface"), text: t.color("--accent-text") },
    success: { border: t.color("--color-success-border"), fill: t.color("--color-success-bg"), text: t.color("--color-success-text") },
    warning: { border: t.color("--color-warning-border"), fill: t.color("--color-warning-bg"), text: t.color("--color-warning-text") },
    danger: { border: t.color("--color-danger-border"), fill: t.color("--color-danger-bg"), text: t.color("--color-danger-text") },
  }[tone];
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: t.length("--space-xs"),
        minHeight: t.length("--tag-height-sm"),
        paddingVertical: t.length("--tag-padding-block"),
        paddingHorizontal: t.length("--tag-padding-inline-sm"),
        borderWidth: t.length("--border-hairline"),
        borderColor: colors.border,
        borderRadius: t.length("--radius-pill"),
        backgroundColor: colors.fill,
      }}
    >
      {icon ? <HugeiconsIcon icon={icon} size={t.length("--icon-size-xs")} color={colors.text} /> : null}
      <RNText
        numberOfLines={1}
        ellipsizeMode="tail"
        maxFontSizeMultiplier={maxFontScale.badge}
        style={{
          ...fontStyle(t.length("--font-size-1"), t.length("--typo-caption-line-height-tight"), weightValue(t, "regular")),
          color: colors.text,
          flexShrink: 1,
        }}
      >
        {label}
      </RNText>
    </View>
  );
}

/** Place in a ListRow `trailing`. Never pulses. */
export function UnreadDot({ label, present = true }: UnreadDotProps) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(present);
  const opacity = useRef(new Animated.Value(present ? 1 : 0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (present) {
      setMounted(true);
      if (reduced) {
        opacity.setValue(1);
        scale.setValue(1);
        return;
      }
      scale.setValue(0.6);
      run(t, opacity, 1, "--motion-base", "--motion-ease-decelerate").start();
      run(t, scale, 1, "--motion-base", "--motion-ease-decelerate").start();
      return;
    }
    if (reduced) {
      opacity.setValue(0);
      setMounted(false);
      return;
    }
    run(t, opacity, 0, "--motion-exit-base", "--motion-ease-accelerate").start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [present, reduced, t, opacity, scale]);
  const size = t.length("--sidebar-icon-size");
  return (
    <View style={{ width: size, alignItems: "center" }} accessibilityRole="image" accessibilityLabel={label} accessible={mounted}>
      {mounted ? (
        <Animated.View
          style={{
            width: size / 2,
            height: size / 2,
            borderRadius: t.length("--radius-pill"),
            backgroundColor: t.color("--accent"),
            opacity,
            transform: reduced ? undefined : [{ scale }],
          }}
        />
      ) : null}
    </View>
  );
}
