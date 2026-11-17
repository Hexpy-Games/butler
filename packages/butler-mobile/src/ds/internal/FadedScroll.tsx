import { useRef, useState, type ComponentRef } from "react";
import { Platform, ScrollView, View } from "react-native";
import { BlurTargetView, BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { MaskedView } from "@expo/ui/community/masked-view";
import { alpha } from "../../design/tokens";
import { useTokens } from "../../design/useTokens";
import { GLASS_BLUR_IOS } from "./GlassFill";

/** A scrolling body whose clipped edges blur on iOS (colour fade on Android), so a cut-off edge signals more content. */
export function FadedScroll({ children }: { children: React.ReactNode }) {
  const t = useTokens();
  const target = useRef<ComponentRef<typeof View>>(null);
  const viewport = useRef(0);
  const content = useRef(0);
  const offset = useRef(0);
  const [scrolled, setScrolled] = useState(false);
  const [more, setMore] = useState(false);
  const size = t.length("--tinted-glass-edge-size");
  const tint = t.color("--tinted-glass-tint");
  const clear = alpha(tint, 0);
  const blur = Platform.OS === "ios";
  const update = () => {
    setScrolled(offset.current > 0);
    setMore(content.current - viewport.current - offset.current > 0);
  };
  const edge = (side: "top" | "bottom") => {
    const place = { position: "absolute", left: 0, right: 0, [side]: 0, height: size } as const;
    if (!blur) {
      return <LinearGradient pointerEvents="none" colors={side === "top" ? [tint, clear] : [clear, tint]} style={place} />;
    }
    return (
      <MaskedView
        pointerEvents="none"
        style={place}
        maskElement={<LinearGradient colors={side === "top" ? ["black", "transparent"] : ["transparent", "black"]} style={{ flex: 1 }} />}
      >
        <BlurView
          style={{ flex: 1 }}
          tint={t.scheme === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight"}
          intensity={GLASS_BLUR_IOS}
          blurTarget={target}
        />
      </MaskedView>
    );
  };
  const scroll = (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={16}
      onLayout={(event) => {
        viewport.current = event.nativeEvent.layout.height;
        update();
      }}
      onContentSizeChange={(_, height) => {
        content.current = height;
        update();
      }}
      onScroll={(event) => {
        offset.current = event.nativeEvent.contentOffset.y;
        update();
      }}
    >
      {children}
    </ScrollView>
  );
  return (
    <View style={{ flexShrink: 1 }}>
      {blur ? <BlurTargetView ref={target} style={{ flexShrink: 1 }}>{scroll}</BlurTargetView> : scroll}
      {scrolled ? edge("top") : null}
      {more ? edge("bottom") : null}
    </View>
  );
}
