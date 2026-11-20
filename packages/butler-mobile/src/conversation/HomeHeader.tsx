import { Animated, Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BlurView } from "expo-blur";
import { ScrollEdgeEffect } from "@bsky.app/expo-scroll-edge-effect";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { EdgeFade, icons, Text, useTokens } from "@/ds";
import { liquidGlass } from "@/ds/internal/GlassFill";

/** Title row height under the status bar; the list starts below it. */
export const HOME_HEADER_ROW = 56;
/** Visible gear size; hitSlop grows it to --control-hit-target. */
const GEAR = 28;
/** Compact title size the large title shrinks to. */
const COMPACT_TITLE = 20;

/** The magazine title: large right under the status bar at rest, shrinking to a compact title as the list scrolls; the settings gear shares its row. */
export function HomeHeader({ scrollY, title, settingsLabel, onSettings }: {
  scrollY: Animated.Value; title: string; settingsLabel: string; onSettings: () => void;
}) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const edge = t.length("--space-4") + t.length("--space-sm"); // the list rows' content edge (list padding + row padding)
  const collapse = t.length("--control-hit-target"); // scroll distance over which the title shrinks
  const scale = scrollY.interpolate({ inputRange: [0, collapse], outputRange: [1, COMPACT_TITLE / t.length("--typo-h1-size")], extrapolate: "clamp" });
  // Pulling down past the top moves the row with the list instead of tearing away from it.
  const follow = scrollY.interpolate({ inputRange: [-1, 0], outputRange: [1, 0], extrapolateLeft: "extend", extrapolateRight: "clamp" });
  const shade = scrollY.interpolate({ inputRange: [0, collapse], outputRange: [0, 1], extrapolate: "clamp" });
  const height = insets.top + HOME_HEADER_ROW;
  return <ScrollEdgeEffect edge="top" effect="soft" pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0, height }}>
    {Platform.OS === "android" ? <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: shade }]}>
      <View style={{ flex: 1, backgroundColor: t.color("--color-surface-base") }} />
      <EdgeFade edge="top" offset={height} visible />
    </Animated.View> : !liquidGlass ? <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: shade }]}>
      <BlurView style={StyleSheet.absoluteFill} tint="systemChromeMaterial" intensity={100} />
    </Animated.View> : null}
    <Animated.View pointerEvents="box-none" style={{ position: "absolute", top: insets.top, left: 0, right: 0, height: HOME_HEADER_ROW,
      flexDirection: "row", alignItems: "center", paddingHorizontal: edge, transform: [{ translateY: follow }] }}>
      <Animated.View style={{ flex: 1, transformOrigin: "left center", transform: [{ scale }] }}>
        <Text variant="h1" lines={1}>{title}</Text>
      </Animated.View>
      <Pressable accessibilityRole="button" accessibilityLabel={settingsLabel} onPress={onSettings}
        hitSlop={(t.length("--control-hit-target") - GEAR) / 2} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
        <HugeiconsIcon icon={icons.Settings} size={GEAR} color={t.color("--text-primary")} />
      </Pressable>
    </Animated.View>
  </ScrollEdgeEffect>;
}
