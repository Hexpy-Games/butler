import { useEffect, useRef } from "react";
import { Animated, View } from "react-native";
import { PILL } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { toEasing, useReducedMotion } from "./internal/motion";
import { Text } from "./Text";

export function Meter({ label, meta, value }: { label: string; meta: string; value: number /* 0–100 */ }) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const width = useRef(new Animated.Value(value)).current;
  useEffect(() => {
    if (reduced) width.setValue(value);
    else Animated.timing(width, { toValue: value, useNativeDriver: false,
      duration: t.duration("--motion-base"), easing: toEasing(t.easing("--motion-ease-standard")) }).start();
  }, [value, reduced, t, width]);
  return <View style={{ gap: t.length("--space-1") }}>
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      <Text variant="caption" tone="secondary">{label}</Text>
      <Text variant="caption" numeric="tabular">{meta}</Text>
    </View>
    <View style={{ height: t.length("--space-1"), borderRadius: t.length(PILL), backgroundColor: t.color("--context-track-bg") }}>
      <Animated.View style={{ height: t.length("--space-1"), borderRadius: t.length(PILL), backgroundColor: t.color("--accent"),
        width: width.interpolate({ inputRange: [0, 100], outputRange: ["0%", "100%"] }) }} />
    </View>
  </View>;
}
