import { createContext, useContext, type ComponentRef, type RefObject } from "react";
import { PixelRatio, Platform, StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { opaque, type Tokens } from "../../design/tokens";
import { useTokens } from "../../design/useTokens";

export interface Radii { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number }

/** The blur target glass floats over (set by GlassBackdrop); Android blurs only a target's content. */
export const GlassTarget = createContext<RefObject<ComponentRef<typeof View> | null> | null>(null);

/** True where the platform has Liquid Glass (iOS 26+); glass then uses that material instead of our tint. */
export const liquidGlass = Platform.OS === "ios" && isLiquidGlassAvailable();

// Mobile glass sits over text; owner asked for more blur than the web's 4px (2026-11-17).
export const GLASS_BLUR_IOS = 50; // UIVisualEffectView intensity
export const GLASS_BLUR_DP = 16; // Android fallback blur radius in dp

/** The glass layers: a blur and one uniform tint. Without a blur it is a plain, fully opaque --popover fill. */
export function GlassFill({ radii }: { radii: Radii }) {
  const t = useTokens();
  const target = useContext(GlassTarget);
  const canBlur = Platform.OS === "ios" || (Platform.OS === "android" && Number(Platform.Version) >= 31 && target != null);
  const border = t.length("--border-hairline");
  const box = {
    ...StyleSheet.absoluteFill,
    overflow: "hidden",
    borderTopLeftRadius: Math.max(radii.topLeft - border, 0),
    borderTopRightRadius: Math.max(radii.topRight - border, 0),
    borderBottomRightRadius: Math.max(radii.bottomRight - border, 0),
    borderBottomLeftRadius: Math.max(radii.bottomLeft - border, 0),
  } as const;
  const tint = t.scheme === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight";
  if (liquidGlass) {
    return (
      <View pointerEvents="none" style={box}>
        <BlurView style={StyleSheet.absoluteFill} intensity={GLASS_BLUR_IOS} tint={tint} />
        <GlassView style={StyleSheet.absoluteFill} glassEffectStyle="regular" colorScheme={t.scheme} />
      </View>
    );
  }
  return (
    <View pointerEvents="none" style={{ ...box, backgroundColor: canBlur ? undefined : opaque(t.color("--popover")) }}>
      {canBlur ? (
        <>
          <BlurView
            style={StyleSheet.absoluteFill}
            tint={tint}
            intensity={Platform.OS === "ios" ? GLASS_BLUR_IOS : GLASS_BLUR_DP * PixelRatio.get()}
            blurMethod="dimezisBlurViewSdk31Plus"
            blurTarget={target ?? undefined}
          />
          <View style={{ ...StyleSheet.absoluteFill, backgroundColor: t.color("--tinted-glass-bg") }} />
        </>
      ) : null}
    </View>
  );
}

/** Outer box shadow of a glass surface: its drop shadow plus the inset top highlight. */
export function glassShadow(t: Tokens) {
  if (liquidGlass) return [];
  return [
    ...t.shadow("--tinted-glass-shadow"),
    { offsetX: 0, offsetY: 1, blurRadius: 0, spreadDistance: 0, color: t.color("--tinted-glass-highlight"), inset: true },
  ];
}
