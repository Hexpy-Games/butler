import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text as RNText, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Tokens } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { icons, type IconGlyph } from "./icons";
import { IconSlot } from "./internal/IconSlot";
import { run, useReducedMotion } from "./internal/motion";
import { maxFontScale, textStyle } from "./internal/typography";

export type ToastTone = "neutral" | "success" | "warning" | "error";
interface ToastInput { message: string; tone?: ToastTone; durationMs?: number }
interface Current extends ToastInput { id: number }

let current: Current | null = null;
let counter = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** One toast at a time: a new one replaces the current one at once. */
export function showToast(input: ToastInput): void {
  current = { ...input, id: ++counter };
  emit();
}

function clearToast(id: number) {
  if (current?.id === id) {
    current = null;
    emit();
  }
}

type ColorKey = Parameters<Tokens["color"]>[0];
const tones: Record<ToastTone, null | { bg: ColorKey; border: ColorKey; text: ColorKey; icon: IconGlyph }> = {
  neutral: null,
  success: { bg: "--color-success-bg", border: "--color-success-border", text: "--color-success", icon: icons.CheckCircle2 },
  warning: { bg: "--color-warning-bg", border: "--color-warning-border", text: "--color-warning-text", icon: icons.AlertCircle },
  error: { bg: "--color-danger-bg", border: "--color-danger-border", text: "--color-danger-text", icon: icons.AlertCircle },
};

/** The toast surface without motion or position: exported for the gallery only. */
export function ToastView({ message, tone = "neutral", onPress }: { message: string; tone?: ToastTone; onPress?: () => void }) {
  const t = useTokens();
  const radius = t.length("--radius-panel");
  const palette = tones[tone];
  const text = t.color(palette?.text ?? "--text-primary");
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        width: "100%",
        maxWidth: t.length("--dialog-width-sm"),
        flexDirection: "row",
        alignItems: "flex-start",
        gap: t.length("--space-sm"),
        paddingVertical: t.length("--space-md"),
        paddingHorizontal: t.length("--space-lg"),
        borderRadius: radius,
        borderWidth: t.length("--border-hairline"),
        borderColor: t.color(palette?.border ?? "--line"),
        backgroundColor: t.color("--popover"),
        boxShadow: t.shadow("--shadow-card"),
      }}
    >
      {palette ? (
        <View pointerEvents="none" style={{ ...StyleSheet.absoluteFill, borderRadius: radius, backgroundColor: t.color(palette.bg) }} />
      ) : null}
      {palette ? (
        <IconSlot size={t.length("--icon-size-md")} lineHeight={t.length("--typo-label-line-height")}>
          <HugeiconsIcon icon={palette.icon} size={t.length("--icon-size-md")} color={text} />
        </IconSlot>
      ) : null}
      <RNText
        numberOfLines={3}
        ellipsizeMode="tail"
        maxFontSizeMultiplier={maxFontScale.control}
        style={{ ...textStyle(t, "label"), color: text, flex: 1 }}
      >
        {message}
      </RNText>
    </Pressable>
  );
}

export function ToastHost() {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const next = useSyncExternalStore(subscribe, () => current);
  const [shown, setShown] = useState<Current | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const lift = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const distance = t.length("--motion-distance-lg");

  const animate = (enter: boolean, done?: () => void) => {
    const fade = reduced
      ? run(t, opacity, enter ? 1 : 0, "--motion-fast", "--motion-ease-standard")
      : run(t, opacity, enter ? 1 : 0, enter ? "--motion-enter-overlay" : "--motion-exit-base", enter ? "--motion-ease-enter" : "--motion-ease-exit");
    const travel = run(t, lift, enter ? 0 : -distance, enter ? "--motion-enter-overlay" : "--motion-exit-base", enter ? "--motion-ease-enter" : "--motion-ease-exit");
    Animated.parallel(reduced ? [fade] : [fade, travel]).start(({ finished }) => finished && done?.());
  };

  useEffect(() => {
    if (!next) return;
    setShown(next);
    opacity.setValue(0);
    lift.setValue(reduced ? 0 : -distance);
    animate(true);
    AccessibilityInfo.announceForAccessibility(next.message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => dismiss(next.id), next.durationMs ?? 4000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next]);

  const dismiss = (id: number) => {
    if (timer.current) clearTimeout(timer.current);
    animate(false, () => {
      clearToast(id);
      setShown((now) => (now?.id === id ? null : now));
    });
  };

  if (!shown) return <View />;
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: insets.top + t.length("--space-2"),
        left: t.length("--adaptive-page-gutter"),
        right: t.length("--adaptive-page-gutter"),
        alignItems: "center",
      }}
    >
      <Animated.View style={{ width: "100%", alignItems: "center", opacity, transform: [{ translateY: lift }] }}>
        <ToastView message={shown.message} tone={shown.tone} onPress={() => dismiss(shown.id)} />
      </Animated.View>
    </View>
  );
}
