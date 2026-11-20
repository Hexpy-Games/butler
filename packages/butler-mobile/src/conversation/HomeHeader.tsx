import type { ComponentType, ReactElement } from "react";
import { Animated, Platform, Pressable, StyleSheet, View, type ViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import MaskedView from "@react-native-masked-view/masked-view";
import { ScrollEdgeEffect } from "@bsky.app/expo-scroll-edge-effect";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { icons, Text, useTokens } from "@/ds";
import { alpha } from "@/design/tokens";
import { GlassFill, GLASS_BLUR_IOS } from "@/ds/internal/GlassFill";

const Mask = MaskedView as unknown as ComponentType<ViewProps & { maskElement: ReactElement }>; // 0.3.2 class typings predate @types/react 19

/** Title row height under the status bar; the list starts below it. */
export const HOME_HEADER_ROW = 56;

/** The magazine title at full size right under the status bar, with the settings gear as a glass circle on its row. Rows scrolling behind it sink into a progressive blur (iOS) or the surface fade (Android), strongest at the top. */
export function HomeHeader({ scrollY, title, settingsLabel, onSettings }: {
  scrollY: Animated.Value; title: string; settingsLabel: string; onSettings: () => void;
}) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const edge = t.length("--space-4") + t.length("--space-sm"); // the list rows' content edge (list padding + row padding)
  const button = t.length("--control-hit-target");
  const pill = button / 2;
  // Pulling down past the top moves the row with the list instead of tearing away from it.
  const follow = scrollY.interpolate({ inputRange: [-1, 0], outputRange: [1, 0], extrapolateLeft: "extend", extrapolateRight: "clamp" });
  // The blur appears as rows start to pass under the header (nothing to blur at rest).
  const shade = scrollY.interpolate({ inputRange: [0, button], outputRange: [0, 1], extrapolate: "clamp" });
  const height = insets.top + HOME_HEADER_ROW;
  const reach = height + t.length("--space-4"); // the blur fades out a little below the title row
  const surface = t.color("--color-surface-base");
  return <ScrollEdgeEffect edge="top" effect="soft" pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0, height }}>
    <Animated.View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: reach, opacity: shade }}>
      {Platform.OS === "ios"
        ? <Mask style={StyleSheet.absoluteFill} maskElement={<LinearGradient style={StyleSheet.absoluteFill}
            colors={["#000", "#000", "transparent"]} locations={[0, height / reach, 1]} />}>
            <BlurView style={StyleSheet.absoluteFill} intensity={GLASS_BLUR_IOS} tint={t.scheme === "dark" ? "dark" : "light"} />
          </Mask>
        : <LinearGradient style={StyleSheet.absoluteFill} colors={[surface, surface, alpha(surface, 0)]} locations={[0, height / reach, 1]} />}
    </Animated.View>
    <Animated.View pointerEvents="box-none" style={{ position: "absolute", top: insets.top, left: 0, right: 0, height: HOME_HEADER_ROW,
      flexDirection: "row", alignItems: "center", paddingHorizontal: edge, transform: [{ translateY: follow }] }}>
      <View style={{ flex: 1 }}><Text variant="h1" lines={1}>{title}</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel={settingsLabel} onPress={onSettings}
        style={({ pressed }) => ({ width: button, height: button, borderRadius: pill, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.6 : 1 })}>
        <GlassFill radii={{ topLeft: pill, topRight: pill, bottomRight: pill, bottomLeft: pill }} />
        <HugeiconsIcon icon={icons.Settings} size={t.length("--titlebar-action-icon-size")} color={t.color("--text-primary")} />
      </Pressable>
    </Animated.View>
  </ScrollEdgeEffect>;
}
