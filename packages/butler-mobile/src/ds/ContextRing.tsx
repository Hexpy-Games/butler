import { Pressable } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useTokens } from "../design/useTokens";

export function ContextRing({ ratio, label, onPress }: { ratio: number; label: string; onPress(): void }) {
  const t = useTokens();
  const target = t.length("--control-hit-target");
  const diameter = Math.round(target * 0.5) || 18;
  const stroke = t.length("--border-hairline") * 3.5;
  const radius = (diameter - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return <Pressable onPress={onPress}
    style={{ width: target, height: target, alignItems: "center", justifyContent: "center" }}
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
  </Pressable>;
}
