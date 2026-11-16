import { useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { alpha } from "../../design/tokens";
import { useTokens } from "../../design/useTokens";

/** A scrolling body whose clipped edges fade, so a cut-off edge signals more content. */
export function FadedScroll({ children }: { children: React.ReactNode }) {
  const t = useTokens();
  const viewport = useRef(0);
  const content = useRef(0);
  const offset = useRef(0);
  const [scrolled, setScrolled] = useState(false);
  const [more, setMore] = useState(false);
  const size = t.length("--scroll-fade-size");
  const tint = t.color("--tinted-glass-tint");
  const clear = alpha(tint, 0);
  const update = () => {
    setScrolled(offset.current > 0);
    setMore(content.current - viewport.current - offset.current > 0);
  };
  return (
    <View style={{ flexShrink: 1 }}>
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
      {scrolled ? (
        <LinearGradient pointerEvents="none" colors={[tint, clear]} style={{ position: "absolute", top: 0, left: 0, right: 0, height: size }} />
      ) : null}
      {more ? (
        <LinearGradient pointerEvents="none" colors={[clear, tint]} style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: size }} />
      ) : null}
    </View>
  );
}
