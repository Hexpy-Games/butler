import { Platform } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { alpha } from "../design/tokens";
import { useTokens } from "../design/useTokens";

export function EdgeFade({ edge, offset = 0, visible, color: background }: { edge: "top" | "bottom"; offset?: number; visible: boolean; color?: string }) {
  const t = useTokens();
  if (Platform.OS !== "android" || !visible) return null;
  const color = background ?? t.color("--color-surface-base");
  const size = t.length("--tinted-glass-edge-size");
  if (edge === "bottom") {
    return <LinearGradient pointerEvents="none"
      colors={[alpha(color, 0), color, color]}
      locations={[0, size / (offset + size), 1]}
      style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: offset + size }} />;
  }
  return <LinearGradient pointerEvents="none"
    colors={[color, alpha(color, 0)]}
    style={{ position: "absolute", left: 0, right: 0, height: size, top: offset }} />;
}
