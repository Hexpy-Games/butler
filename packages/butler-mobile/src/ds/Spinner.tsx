import { useEffect, useRef } from "react";
import { Animated } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useTokens } from "../design/useTokens";
import type { IconProps } from "./Icon";
import { toEasing } from "./internal/motion";
import { toneColors } from "./internal/typography";

export interface SpinnerProps { size?: number; tone?: IconProps["tone"]; label?: string }
export interface SpinnerArcProps { size?: number; color: string; label?: string }

const RADIUS = 36.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function Spinner({ size, tone = "primary", label }: SpinnerProps) {
  const t = useTokens();
  return <SpinnerArc size={size} label={label} color={t.color(tone === "accent" ? "--accent-text" : toneColors[tone])} />;
}

/** The arc in an arbitrary colour, for controls that spin in their own label colour. */
export function SpinnerArc({ size, color, label }: SpinnerArcProps) {
  const t = useTokens();
  const drawn = size ?? t.length("--icon-size-md");
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    turn.setValue(0);
    const loop = Animated.loop(
      Animated.timing(turn, {
        toValue: 1,
        duration: t.duration("--spinner-rotate-duration"),
        easing: toEasing(t.easing("--motion-ease-linear")),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [t, turn]);
  const spin = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const hidden = label === undefined;
  return (
    <Animated.View
      style={{ width: drawn, height: drawn, transform: [{ rotate: spin }] }}
      accessibilityRole={hidden ? undefined : "progressbar"}
      accessibilityLabel={label}
      accessible={hidden ? undefined : true}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? "no" : "auto"}
    >
      <Svg width={drawn} height={drawn} viewBox="0 0 100 100">
        <Circle
          cx={50}
          cy={50}
          r={RADIUS}
          fill="none"
          stroke={color}
          strokeLinecap="round"
          strokeWidth={(Math.max(1.35, drawn * 0.071) * 100) / drawn}
          strokeDasharray={[0.79 * CIRCUMFERENCE, 0.21 * CIRCUMFERENCE]}
          rotation={-90}
          origin="50,50"
        />
      </Svg>
    </Animated.View>
  );
}
