import { StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { alpha, type Tokens } from "../../design/tokens";
import { useTokens } from "../../design/useTokens";

export interface Radii { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number }

/** The glass layers: a fill, a tinted centre and two edge fades. No backdrop blur. */
export function GlassFill({ radii, fadeTop = true, fadeBottom = true }: { radii: Radii; fadeTop?: boolean; fadeBottom?: boolean }) {
  const t = useTokens();
  const edge = t.length("--tinted-glass-edge-size");
  const border = t.length("--border-hairline");
  const tint = t.color("--tinted-glass-tint");
  const clear = alpha(tint, 0);
  return (
    <View
      pointerEvents="none"
      style={{
        ...StyleSheet.absoluteFill,
        overflow: "hidden",
        borderTopLeftRadius: Math.max(radii.topLeft - border, 0),
        borderTopRightRadius: Math.max(radii.topRight - border, 0),
        borderBottomRightRadius: Math.max(radii.bottomRight - border, 0),
        borderBottomLeftRadius: Math.max(radii.bottomLeft - border, 0),
        backgroundColor: t.color("--tinted-glass-bg"),
      }}
    >
      <View style={{ ...StyleSheet.absoluteFill, top: fadeTop ? edge : 0, bottom: fadeBottom ? edge : 0, backgroundColor: tint }} />
      {fadeTop ? (
        <LinearGradient colors={[clear, tint]} style={{ position: "absolute", top: 0, left: 0, right: 0, height: edge }} />
      ) : null}
      {fadeBottom ? (
        <LinearGradient colors={[tint, clear]} style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: edge }} />
      ) : null}
    </View>
  );
}

/** Outer box shadow of a glass surface: its drop shadow plus the inset top highlight. */
export function glassShadow(t: Tokens) {
  return [
    ...t.shadow("--tinted-glass-shadow"),
    { offsetX: 0, offsetY: 1, blurRadius: 0, spreadDistance: 0, color: t.color("--tinted-glass-highlight"), inset: true },
  ];
}
