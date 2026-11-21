import { useEffect, useId, useRef, useState } from "react";
import { Animated, Image, StyleSheet, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import type { ImageFrameAspect } from "../conversation/imageOutputs";
import { alpha } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { TILE_RADIUS } from "./AttachmentTiles";
import { Icon } from "./Icon";
import { icons } from "./icons";
import { run, useReducedMotion } from "./internal/motion";

export function ImageFrame({ source, aspect, fit }: {
  source?: { uri: string; headers: Record<string, string> }; aspect: ImageFrameAspect; fit: "fill" | "matte";
}) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const [failed, setFailed] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const placeholder = !source || failed;
  const [w, h] = aspect.split(":").map(Number);
  const gradient = useId();
  useEffect(() => { setFailed(false); opacity.setValue(0); }, [source?.uri, opacity]);
  useEffect(() => {
    if (!placeholder) return;
    if (reduced) { opacity.setValue(1); return; }
    const animation = run(t, opacity, 1, "--motion-slow", "--motion-ease-decelerate");
    animation.start();
    return () => animation.stop();
  }, [placeholder, reduced, opacity, t]);
  const loaded = () => {
    if (reduced) opacity.setValue(1);
    else run(t, opacity, 1, "--motion-slow", "--motion-ease-decelerate").start();
  };
  const inset = fit === "matte" ? t.length("--space-md") : 0;
  return <View accessibilityElementsHidden style={{ aspectRatio: w / h, borderRadius: TILE_RADIUS,
    overflow: "hidden", backgroundColor: t.color("--muted") }}>
    {placeholder ? <Animated.View style={[StyleSheet.absoluteFill, { opacity, alignItems: "center", justifyContent: "center" }]}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs><RadialGradient id={gradient} cx="50%" cy="45%" r="100%">
          <Stop offset={0} stopColor={alpha(t.color("--accent"), 0.1)} />
          <Stop offset={0.72} stopColor={alpha(t.color("--accent"), 0)} />
        </RadialGradient></Defs>
        <Rect width="100%" height="100%" fill={`url(#${gradient})`} />
      </Svg>
      <Icon glyph={icons.Image} size="xl" tone="tertiary" />
    </Animated.View> : <Animated.View style={{ position: "absolute", top: inset, right: inset, bottom: inset, left: inset,
      opacity: reduced ? 1 : opacity, borderRadius: fit === "matte" ? TILE_RADIUS / 2 : 0,
      borderWidth: fit === "matte" ? t.length("--border-hairline") : 0, borderColor: t.color("--line"),
      boxShadow: fit === "matte" ? t.shadow("--browser-card-shadow") : undefined }}>
      <Image source={source} resizeMode="contain" style={[StyleSheet.absoluteFill, { borderRadius: fit === "matte" ? TILE_RADIUS / 2 : 0 }]}
        onLoad={loaded} onError={() => { opacity.setValue(0); setFailed(true); }} />
    </Animated.View>}
  </View>;
}
