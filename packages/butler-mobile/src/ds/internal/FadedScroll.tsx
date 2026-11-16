import { useState } from "react";
import { ScrollView, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { alpha } from "../../design/tokens";
import { useTokens } from "../../design/useTokens";

/** A scrolling body whose clipped edges fade, so a cut-off edge signals more content. */
export function FadedScroll({ children }: { children: React.ReactNode }) {
  const t = useTokens();
  const [viewport, setViewport] = useState(0);
  const [content, setContent] = useState(0);
  const [offset, setOffset] = useState(0);
  const size = t.length("--scroll-fade-size");
  const tint = t.color("--tinted-glass-tint");
  const clear = alpha(tint, 0);
  const scrolled = offset > 0;
  const more = content - viewport - offset > 0;
  return (
    <View style={{ flexShrink: 1 }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onLayout={(event) => setViewport(event.nativeEvent.layout.height)}
        onContentSizeChange={(_, height) => setContent(height)}
        onScroll={(event) => setOffset(event.nativeEvent.contentOffset.y)}
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
