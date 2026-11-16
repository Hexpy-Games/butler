import { useEffect, useRef } from "react";
import { Animated } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useTokens } from "../../design/useTokens";
import { icons } from "../icons";
import { SpinnerArc } from "../Spinner";
import { run, useReducedMotion } from "./motion";
import { AnimatedPressable, usePress } from "./press";

export interface SendButtonProps {
  mode: "send" | "stop";
  enabled: boolean;
  busy: boolean;
  label: string;
  onPress: () => void;
}

export function SendButton({ mode, enabled, busy, label, onPress }: SendButtonProps) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const active = mode === "stop" || enabled;
  const dimmed = !active && !busy;
  const press = usePress({ scale: true, disabled: !active || busy });
  const dim = useRef(new Animated.Value(dimmed ? 0.56 : 1)).current;
  useEffect(() => {
    if (reduced) dim.setValue(dimmed ? 0.56 : 1);
    else run(t, dim, dimmed ? 0.56 : 1, "--motion-fast", "--motion-ease-standard").start();
  }, [dimmed, reduced, t, dim]);
  const target = t.length("--control-hit-target");
  const background = mode === "stop" && !busy ? t.color("--send-stop-bg") : active && !busy ? t.color("--send-bg") : t.color("--send-disabled-bg");
  return (
    <Animated.View style={{ opacity: dim }}>
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: !active || busy, busy }}
        disabled={!active || busy}
        onPress={onPress}
        {...press.handlers}
        style={[
          {
            width: target, height: target, alignItems: "center", justifyContent: "center",
            borderRadius: t.length("--radius-pill"), backgroundColor: background, opacity: press.opacity,
          },
          press.scaleStyle,
          press.focused ? { boxShadow: t.shadow("--focus-ring") } : null,
        ]}
      >
        {busy ? (
          <SpinnerArc size={t.length("--icon-size-md")} color={t.color("--text-secondary")} />
        ) : mode === "stop" ? (
          <HugeiconsIcon icon={icons.Square} size={t.length("--icon-size-sm")} color={t.color("--send-fg")} />
        ) : (
          <HugeiconsIcon icon={icons.SendHorizontal} size={t.length("--icon-size-md")} color={t.color("--send-fg")} />
        )}
      </AnimatedPressable>
    </Animated.View>
  );
}
