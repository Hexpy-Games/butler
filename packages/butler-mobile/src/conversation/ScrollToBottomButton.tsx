import { useEffect, useRef, useState } from "react";
import { Animated, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { icons, useTokens } from "@/ds";
import { mix } from "@/design/tokens";
import { GlassFill, glassShadow, liquidGlass } from "@/ds/internal/GlassFill";
import { AnimatedPressable, usePress } from "@/ds/internal/press";
import { run, useReducedMotion } from "@/ds/internal/motion";
import { IconSlot } from "@/ds/internal/IconSlot";
import { BaseText } from "@/ds/internal/BaseText";
import { textStyle, maxFontScale } from "@/ds/internal/typography";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useAppLocale } from "@/i18n";

export function ScrollToBottomButton({ visible, unread, onPress }: { visible: boolean; unread: boolean; onPress: () => void }) {
  const t = useTokens();
  const copy = getAppCopy(useAppLocale()).conversation.scrollToBottom;
  const press = usePress({ scale: true });
  const reduced = useReducedMotion();
  const distance = t.length("--motion-distance-md");
  const [mounted, setMounted] = useState(visible);
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const lift = useRef(new Animated.Value(visible ? 0 : distance)).current;
  useEffect(() => {
    if (visible) setMounted(true);
    const duration = visible ? "--motion-enter-overlay" : "--motion-exit-base";
    const easing = visible ? "--motion-ease-enter" : "--motion-ease-exit";
    if (reduced) lift.setValue(0);
    const fade = run(t, opacity, visible ? 1 : 0, duration, easing);
    const animation = Animated.parallel(reduced ? [fade] : [fade, run(t, lift, visible ? 0 : distance, duration, easing)]);
    animation.start(({ finished }) => { if (finished && !visible) setMounted(false); });
    return () => animation.stop();
  }, [visible, reduced]);
  if (!mounted) return null;

  const height = t.length("--control-height-sm");
  const v = (t.length("--control-hit-target") - height) / 2;
  const hitSlop = { top: v, bottom: v, left: t.length("--space-1"), right: t.length("--space-1") };
  const r = height / 2;
  const iconSize = t.length("--icon-size-md");
  const fg = t.color(unread ? "--accent-text" : "--text-primary");
  const box = {
    minHeight: height,
    paddingStart: t.length("--space-2"),
    paddingEnd: t.length("--space-3"),
    borderRadius: t.length("--radius-pill"),
    borderWidth: unread || !liquidGlass ? t.length("--border-hairline") : 0,
    borderColor: unread ? mix(t.color("--accent"), 0.58, t.color("--line")) : t.color("--tinted-glass-border"),
    boxShadow: glassShadow(t),
    alignItems: "center",
    justifyContent: "center",
    maxWidth: "100%",
    opacity: press.opacity,
  } as const;
  return (
    <Animated.View pointerEvents={visible ? "box-none" : "none"} style={{ maxWidth: "100%", opacity, transform: [{ translateY: lift }] }}>
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityLabel={copy.ariaLabel}
        hitSlop={hitSlop}
        onPress={onPress}
        {...press.handlers}
        style={[box, press.scaleStyle, press.focused ? { boxShadow: t.shadow("--focus-ring") } : null]}
      >
        <GlassFill radii={{ topLeft: r, topRight: r, bottomRight: r, bottomLeft: r }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-sm") }}>
          <IconSlot size={iconSize} lineHeight={t.length("--typo-caption-line-height")}>
            <HugeiconsIcon icon={icons.ChevronDown} size={iconSize} color={fg} />
          </IconSlot>
          <BaseText
            numberOfLines={1}
            ellipsizeMode="tail"
            maxFontSizeMultiplier={maxFontScale.control}
            style={{ ...textStyle(t, "caption", "medium"), color: fg, flexShrink: 1 }}
          >
            {unread ? copy.newMessagesLabel : copy.label}
          </BaseText>
        </View>
      </AnimatedPressable>
    </Animated.View>
  );
}
