import { useEffect, useRef, useState, type ComponentType, type ReactElement } from "react";
import { Animated, StyleSheet, View, type ViewProps } from "react-native";
import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import { useTokens } from "../design/useTokens";
import { Text } from "./Text";
import { ThinkingMark } from "./ThinkingMark";
import { run, useReducedMotion } from "./internal/motion";

const Mask = MaskedView as unknown as ComponentType<ViewProps & { maskElement: ReactElement }>; // 0.3.2 class typings predate @types/react 19

export interface StatusLineProps { label: string; elapsed?: string; active: boolean }

export function StatusLine({ label, elapsed, active }: StatusLineProps) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const [labelWidth, setLabelWidth] = useState(0);
  const enter = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const shimmer = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    enter.setValue(reduced ? 1 : 0);
    if (reduced) return;
    const animation = run(t, enter, 1, "--motion-base", "--motion-ease-standard");
    animation.start();
    return () => animation.stop();
  }, [label, reduced, t, enter]);
  useEffect(() => {
    shimmer.setValue(0);
    if (!active || reduced) return;
    const loop = Animated.loop(run(t, shimmer, -labelWidth, "--shimmer-duration", "--motion-ease-linear"));
    loop.start();
    return () => loop.stop();
  }, [active, reduced, labelWidth, t, shimmer]);
  const text = <Text tone="secondary" lines={1}>{elapsed ? `${label} · ${elapsed}` : label}</Text>;
  const shimmering = active && !reduced;
  return <View accessible accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "center",
    gap: t.length("--space-2"), height: t.length("--typo-body-line-height"), overflow: "hidden" }}>
    <ThinkingMark working={active} size={t.length("--icon-size-md")} />
    <Animated.View key={label} style={{ flexShrink: 1, opacity: enter,
      transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [t.length("--motion-distance-md"), 0] }) }] }}>
      <View onLayout={event => setLabelWidth(event.nativeEvent.layout.width)} style={{ opacity: shimmering ? 0 : 1 }}>{text}</View>
      {shimmering ? <Mask style={StyleSheet.absoluteFill} maskElement={text}>
        <Animated.View style={{ width: labelWidth * 2, height: "100%", transform: [{ translateX: shimmer }] }}>
          <LinearGradient style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            colors={[t.color("--text-secondary"), t.color("--text-secondary"), t.color("--text-primary"), t.color("--text-secondary"), t.color("--text-secondary")]}
            locations={[0, 0.4, 0.5, 0.6, 1]} />
        </Animated.View>
      </Mask> : null}
    </Animated.View>
  </View>;
}
