import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { opaque, RADIUS } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { GlassFill, glassShadow, liquidGlass } from "./internal/GlassFill";

type Edge = "top" | "bottom" | "left" | "right";

export interface SurfaceProps {
  children?: React.ReactNode;
  variant?: "base" | "raised" | "card" | "glass" | "conversation";
  padding?: "none" | "sm" | "md" | "lg";
  grow?: boolean;
  edges?: readonly Edge[];
}

const paddings = { sm: "--space-2", md: "--space-3", lg: "--space-4" } as const;

export function Surface({ children, variant = "base", padding, grow, edges = [] }: SurfaceProps) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const framed = variant === "card" || variant === "glass";
  const corner = variant === "base" || variant === "conversation" ? 0 : t.length(RADIUS);
  const round = (a: Edge, b: Edge) => (edges.includes(a) || edges.includes(b) ? 0 : corner);
  const radii = { topLeft: round("top", "left"), topRight: round("top", "right"), bottomRight: round("bottom", "right"), bottomLeft: round("bottom", "left") };
  const pad = padding ?? (framed ? "md" : "none");
  const inset = pad === "none" ? 0 : t.length(paddings[pad]);
  const background =
    variant === "base" ? t.color("--color-surface-base")
    : variant === "raised" ? t.color("--color-surface-raised-opaque")
    : variant === "card" ? t.color("--surface-raised")
    : undefined;
  const gradient = variant === "conversation" ? t.gradient("--conversation-bg") : null;
  return (
    <View
      style={{
        flex: grow ? 1 : undefined,
        backgroundColor: background,
        borderTopLeftRadius: radii.topLeft,
        borderTopRightRadius: radii.topRight,
        borderBottomRightRadius: radii.bottomRight,
        borderBottomLeftRadius: radii.bottomLeft,
        borderWidth: framed && !(variant === "glass" && liquidGlass) ? t.length("--border-hairline") : 0,
        borderColor: variant === "glass" ? t.color("--tinted-glass-border") : t.color("--line"),
        boxShadow: variant === "glass" ? glassShadow(t) : undefined,
        paddingTop: inset + (edges.includes("top") ? insets.top : 0),
        paddingBottom: inset + (edges.includes("bottom") ? insets.bottom : 0),
        paddingLeft: inset + (edges.includes("left") ? insets.left : 0),
        paddingRight: inset + (edges.includes("right") ? insets.right : 0),
      }}
    >
      {variant === "glass" ? (
        <GlassFill radii={radii} />
      ) : null}
      {gradient ? <LinearGradient style={StyleSheet.absoluteFill} pointerEvents="none"
        colors={gradient.stops.map(([color]) => opaque(color)) as [string, string, ...string[]]}
        locations={gradient.stops.map(([, offset]) => offset) as [number, number, ...number[]]} /> : null}
      {children}
    </View>
  );
}
