import { Platform } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { alpha } from "../design/tokens";
import { useTokens } from "../design/useTokens";

export function EdgeFade({ edge, offset = 0, visible, color: background }: { edge: "top" | "bottom"; offset?: number; visible: boolean; color?: string }) {
  const t = useTokens();
  if (Platform.OS !== "android" || !visible) return null;
  const color = background ?? t.color("--color-surface-base");
  return <LinearGradient pointerEvents="none"
    colors={edge === "top" ? [color, alpha(color, 0)] : [alpha(color, 0), color]}
    style={{ position: "absolute", left: 0, right: 0, height: t.length("--tinted-glass-edge-size"),
      ...(edge === "top" ? { top: offset } : { bottom: offset }) }} />;
}
