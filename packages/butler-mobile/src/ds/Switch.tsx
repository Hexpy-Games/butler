import { useEffect, useRef } from "react";
import { Animated, Pressable } from "react-native";
import { useTokens } from "../design/useTokens";
import { run, useReducedMotion } from "./internal/motion";
import { usePress } from "./internal/press";

export interface SwitchProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  testID?: string;
}

// The web CSS draws the switch with these four literals too.
const TRACK_WIDTH = 34;
const TRACK_HEIGHT = 20;
const TRACK_PADDING = 2;
const THUMB = 16;

export function Switch({ value, onValueChange, label, disabled, testID }: SwitchProps) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const press = usePress({ scale: false, disabled });
  const travel = TRACK_WIDTH - 2 * TRACK_PADDING - THUMB;
  const x = useRef(new Animated.Value(value ? travel : 0)).current;
  useEffect(() => {
    if (reduced) x.setValue(value ? travel : 0);
    else run(t, x, value ? travel : 0, "--motion-base", "--motion-ease-spring").start();
  }, [value, reduced, t, x, travel]);
  const target = t.length("--control-hit-target");
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: !!disabled }}
      accessibilityLabel={label}
      testID={testID}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      hitSlop={{
        top: (target - TRACK_HEIGHT) / 2,
        bottom: (target - TRACK_HEIGHT) / 2,
        left: (target - TRACK_WIDTH) / 2,
        right: (target - TRACK_WIDTH) / 2,
      }}
      {...press.handlers}
      style={{
        width: TRACK_WIDTH,
        height: TRACK_HEIGHT,
        padding: TRACK_PADDING,
        borderRadius: t.length("--radius-pill"),
        backgroundColor: value ? t.color("--accent") : t.color("--switch-track-bg"),
        opacity: disabled ? 0.5 : 1,
        boxShadow: press.focused ? t.shadow("--focus-ring") : undefined,
      }}
    >
      <Animated.View
        style={{
          width: THUMB,
          height: THUMB,
          borderRadius: t.length("--radius-pill"),
          backgroundColor: t.color("--switch-thumb"),
          boxShadow: t.shadow("--shadow-control"),
          transform: [{ translateX: x }],
        }}
      />
    </Pressable>
  );
}
