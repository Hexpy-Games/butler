import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useTokens } from "../../design/useTokens";
import { icons } from "../icons";
import { run, useReducedMotion } from "./motion";

// radio/check ring; no border token above hairline
const RING = 1.5;

export function SelectionMark({ kind, selected, disabled, size }: {
  kind: "single" | "multi"; selected: boolean; disabled: boolean; size: number;
}) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const target = selected ? 1 : 0;
  const v = useRef(new Animated.Value(target)).current;
  useEffect(() => {
    if (reduced) v.setValue(target);
    else run(t, v, target, "--motion-fast", "--motion-ease-standard").start();
  }, [reduced, t, target, v]);

  const off = t.color(disabled ? "--interactive-disabled-fg" : "--text-tertiary");
  const on = t.color(disabled ? "--interactive-disabled-fg" : "--primary");
  const circle = { width: size, height: size, borderRadius: size / 2 };
  const dotSize = size * 0.5;
  const transform = [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }];
  return (
    <View pointerEvents="none" style={circle}>
      <View style={[StyleSheet.absoluteFill, { borderRadius: circle.borderRadius, borderWidth: RING, borderColor: off }]} />
      <Animated.View style={[StyleSheet.absoluteFill, {
        borderRadius: circle.borderRadius,
        borderWidth: RING,
        borderColor: on,
        backgroundColor: kind === "multi" ? on : "transparent",
        alignItems: "center",
        justifyContent: "center",
        opacity: v,
        transform: kind === "multi" ? transform : undefined,
      }]}>
        {kind === "single"
          ? <Animated.View style={{ width: dotSize, height: dotSize, borderRadius: dotSize / 2, backgroundColor: on, transform }} />
          : <HugeiconsIcon icon={icons.CheckIcon} size={Math.round(size * 0.7)} color={t.color("--primary-foreground")} />}
      </Animated.View>
    </View>
  );
}
