import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTokens } from "../design/useTokens";
import { GlassFill, glassShadow } from "./internal/GlassFill";

type Edge = "top" | "bottom" | "left" | "right";

export interface SurfaceProps {
  children?: React.ReactNode;
  variant?: "base" | "raised" | "card" | "glass";
  radius?: "control" | "lg" | "panel" | "popover" | "composer";
  padding?: "none" | "sm" | "md" | "lg";
  grow?: boolean;
  edges?: readonly Edge[];
}

const radii = {
  control: "--radius-control",
  lg: "--radius-popover",
  panel: "--radius-panel",
  popover: "--radius-popover",
  composer: "--adaptive-composer-radius",
} as const;
const paddings = { sm: "--space-2", md: "--space-3", lg: "--space-4" } as const;

export function Surface({ children, variant = "base", radius, padding, grow, edges = [] }: SurfaceProps) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const framed = variant === "card" || variant === "glass";
  const chosen = radius ?? (variant === "card" ? "control" : variant === "glass" ? "panel" : undefined);
  const corner = chosen ? t.length(radii[chosen]) : 0;
  const pad = padding ?? (framed ? "md" : "none");
  const inset = pad === "none" ? 0 : t.length(paddings[pad]);
  const background =
    variant === "base" ? t.color("--color-surface-base")
    : variant === "raised" ? t.color("--color-surface-raised-opaque")
    : variant === "card" ? t.color("--surface-raised")
    : undefined;
  return (
    <View
      style={{
        flex: grow ? 1 : undefined,
        backgroundColor: background,
        borderRadius: corner,
        borderWidth: framed ? t.length("--border-hairline") : 0,
        borderColor: variant === "glass" ? t.color("--tinted-glass-border") : t.color("--line"),
        boxShadow: variant === "glass" ? glassShadow(t) : undefined,
        paddingTop: inset + (edges.includes("top") ? insets.top : 0),
        paddingBottom: inset + (edges.includes("bottom") ? insets.bottom : 0),
        paddingLeft: inset + (edges.includes("left") ? insets.left : 0),
        paddingRight: inset + (edges.includes("right") ? insets.right : 0),
      }}
    >
      {variant === "glass" ? (
        <GlassFill radii={{ topLeft: corner, topRight: corner, bottomRight: corner, bottomLeft: corner }} />
      ) : null}
      {children}
    </View>
  );
}
