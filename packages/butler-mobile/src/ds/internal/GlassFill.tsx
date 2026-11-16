import { createContext, useContext, useState, type ComponentRef, type RefObject } from "react";
import { PixelRatio, Platform, StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { alpha, type Tokens } from "../../design/tokens";
import { useTokens } from "../../design/useTokens";

export interface Radii { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number }

/** The blur target glass floats over (set by GlassBackdrop); Android blurs only a target's content. */
export const GlassTarget = createContext<RefObject<ComponentRef<typeof View> | null> | null>(null);

// `--tinted-glass-blur` (4px) as a fraction of the ~30pt system blur.
const GLASS_BLUR_IOS = 14;

/** The glass layers: a blur, a fill and one tint gradient with edge fades. Without a blur it is a plain --popover fill. */
export function GlassFill({ radii, fadeTop = true, fadeBottom = true }: { radii: Radii; fadeTop?: boolean; fadeBottom?: boolean }) {
  const t = useTokens();
  const target = useContext(GlassTarget);
  const [h, setH] = useState(0);
  const canBlur = Platform.OS === "ios" || (Platform.OS === "android" && Number(Platform.Version) >= 31 && target != null);
  const edge = t.length("--tinted-glass-edge-size");
  const border = t.length("--border-hairline");
  const tint = t.color("--tinted-glass-tint");
  const clear = alpha(tint, 0);
  return (
    <View
      pointerEvents="none"
      onLayout={(event) => setH(event.nativeEvent.layout.height)}
      style={{
        ...StyleSheet.absoluteFill,
        overflow: "hidden",
        borderTopLeftRadius: Math.max(radii.topLeft - border, 0),
        borderTopRightRadius: Math.max(radii.topRight - border, 0),
        borderBottomRightRadius: Math.max(radii.bottomRight - border, 0),
        borderBottomLeftRadius: Math.max(radii.bottomLeft - border, 0),
        backgroundColor: canBlur ? t.color("--tinted-glass-bg") : t.color("--popover"),
      }}
    >
      {canBlur ? (
        <BlurView
          style={StyleSheet.absoluteFill}
          tint={t.scheme === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight"}
          intensity={Platform.OS === "ios" ? GLASS_BLUR_IOS : t.length("--tinted-glass-blur") * PixelRatio.get()}
          blurMethod="dimezisBlurViewSdk31Plus"
          blurReductionFactor={1}
          blurTarget={target ?? undefined}
        />
      ) : null}
      {canBlur && h > 0 ? (
        <LinearGradient
          style={StyleSheet.absoluteFill}
          colors={[fadeTop ? clear : tint, tint, tint, fadeBottom ? clear : tint]}
          locations={[0, fadeTop ? Math.min(edge / h, 0.5) : 0, 1 - (fadeBottom ? Math.min(edge / h, 0.5) : 0), 1]}
        />
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
