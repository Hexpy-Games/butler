import { PILL } from "../design/tokens";
import { AnimatedPressable, usePress } from "./internal/press";
import Svg, { Circle } from "react-native-svg";
import { useTokens } from "../design/useTokens";

export function ContextRing({ ratio, label, onPress }: { ratio: number; label: string; onPress(): void }) {
  const t = useTokens();
  const target = t.length("--control-hit-target");
  const box = t.length("--control-height-lg");
  const press = usePress({ scale: true });
  const diameter = t.length("--icon-size-lg");
  const stroke = t.length("--border-hairline") * 3.5;
  const radius = (diameter - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return <AnimatedPressable onPress={onPress} {...press.handlers} hitSlop={(target - box) / 2}
    style={[{ width: box, height: box, alignItems: "center", justifyContent: "center",
      borderRadius: t.length(PILL), opacity: press.opacity }, press.scaleStyle,
      press.focused ? { boxShadow: t.shadow("--focus-ring") } : null]}
    accessibilityRole="button" accessibilityLabel={label}>
    <Svg width={diameter} height={diameter}>
      <Circle cx={diameter / 2} cy={diameter / 2} r={radius} fill="none"
        stroke={t.color("--color-border-strong")} strokeWidth={stroke} />
      <Circle cx={diameter / 2} cy={diameter / 2} r={radius} fill="none"
        stroke={t.color("--accent")} strokeWidth={stroke}
        strokeDasharray={[circumference, circumference]}
        strokeDashoffset={circumference * (1 - Math.max(0, Math.min(1, ratio)))}
        rotation={-90} origin={`${diameter / 2},${diameter / 2}`} />
    </Svg>
  </AnimatedPressable>;
}
