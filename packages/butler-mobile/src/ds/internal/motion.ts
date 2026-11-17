import { useEffect, useState } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import { linearEasing, type EasingToken, type Tokens } from "../../design/tokens";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

export function toEasing(token: EasingToken): (t: number) => number {
  if ("bezier" in token) {
    const [a, b, c, d] = token.bezier;
    return Easing.bezier(a, b, c, d);
  }
  return linearEasing(token.linear);
}

type DurationKey = Parameters<Tokens["duration"]>[0];
type EasingKey = Parameters<Tokens["easing"]>[0];

export function run(
  t: Tokens,
  value: Animated.Value,
  toValue: number,
  durationKey: DurationKey,
  easingKey: EasingKey,
): Animated.CompositeAnimation {
  return Animated.timing(value, {
    toValue,
    duration: t.duration(durationKey),
    easing: toEasing(t.easing(easingKey)),
    useNativeDriver: true,
  });
}
