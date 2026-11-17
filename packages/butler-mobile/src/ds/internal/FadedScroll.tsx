import { useRef, useState, type ComponentType, type ReactElement } from "react";
import { Platform, ScrollView, View, type ViewProps } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import MaskedView from "@react-native-masked-view/masked-view";
import { alpha, opaque } from "../../design/tokens";
import { useTokens } from "../../design/useTokens";
import { GLASS_BLUR_IOS } from "./GlassFill";

const Mask = MaskedView as unknown as ComponentType<ViewProps & { maskElement: ReactElement }>; // 0.3.2 class typings predate @types/react 19

/** A scrolling body whose clipped edges fade into the surface (with a blur on iOS), so a cut-off edge signals more content. */
export function FadedScroll({ children }: { children: React.ReactNode }) {
  const t = useTokens();
  const viewport = useRef(0);
  const content = useRef(0);
  const offset = useRef(0);
  const [scrolled, setScrolled] = useState(false);
  const [more, setMore] = useState(false);
  const size = t.length("--tinted-glass-edge-size");
  const fill = opaque(t.color("--popover")); // the opaque Android sheet panel fill (a Modal cannot blur)
  const clear = alpha(fill, 0);
  const blur = Platform.OS === "ios";
  const update = () => {
    setScrolled(offset.current > 0);
    setMore(content.current - viewport.current - offset.current > 0);
  };
  const edge = (side: "top" | "bottom") => {
    const place = { position: "absolute", left: 0, right: 0, [side]: 0, height: size } as const;
    if (!blur) {
      return <LinearGradient pointerEvents="none" colors={side === "top" ? [fill, clear] : [clear, fill]} style={place} />;
    }
    return (
      <Mask
        pointerEvents="none"
        style={place}
        maskElement={<LinearGradient colors={["transparent", "black", "transparent"]} style={{ flex: 1 }} />}
      >
        <BlurView
          style={{ flex: 1 }}
          tint={t.scheme === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight"}
          intensity={GLASS_BLUR_IOS}
        />
      </Mask>
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
  // iOS: the content itself fades to transparent at a clipped edge, so the surface underneath shows and nothing ends in a cut.
  const mask = (
    <View style={{ flex: 1 }}>
      {scrolled ? <LinearGradient colors={["transparent", "black"]} style={{ height: size }} /> : null}
      <View style={{ flex: 1, backgroundColor: "black" }} />
      {more ? <LinearGradient colors={["black", "transparent"]} style={{ height: size }} /> : null}
    </View>
  );
  return (
    <View style={{ flexShrink: 1 }}>
      {blur ? <Mask style={{ flexShrink: 1 }} maskElement={mask}>{scroll}</Mask> : scroll}
      {scrolled ? edge("top") : null}
      {more ? edge("bottom") : null}
    </View>
  );
}
