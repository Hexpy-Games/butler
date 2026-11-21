import { createContext, useContext, useRef, useState } from "react";
import { Animated, Pressable } from "react-native";
import { useTokens } from "../../design/useTokens";
import { run, useReducedMotion } from "./motion";

export const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Gallery only: renders pressed and focused states statically. */
export const ForcedState = createContext<"pressed" | "focused" | null>(null);

export function usePress(opts: { scale: boolean; disabled?: boolean }) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const forced = useContext(ForcedState);
  const [pressedNow, setPressedNow] = useState(false);
  const [focusedNow, setFocusedNow] = useState(false);
  const scalePress = t.number("--motion-scale-press");
  const scale = useRef(new Animated.Value(forced === "pressed" ? scalePress : 1)).current;
  const animated = opts.scale && !reduced;

  const press = (down: boolean) => {
    setPressedNow(down);
    if (!animated) return;
    run(t, scale, down ? scalePress : 1, down ? "--motion-instant" : "--motion-fast", "--motion-ease-standard").start();
  };
  const pressed = !opts.disabled && (pressedNow || forced === "pressed");
  return {
    pressed,
    focused: focusedNow || forced === "focused",
    handlers: {
      onPressIn: () => press(true),
      onPressOut: () => press(false),
      onFocus: () => setFocusedNow(true),
      onBlur: () => setFocusedNow(false),
    },
    scaleStyle: animated ? { transform: [{ scale }] } : null,
    /** Reduced motion: no scale, the pressed control dims at once. */
    opacity: opts.scale && reduced && pressed ? 0.8 : 1,
  };
}
