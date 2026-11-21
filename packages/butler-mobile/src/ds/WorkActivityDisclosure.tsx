import { useEffect, useRef, type ComponentType, type ReactElement } from "react";
import { Animated, LayoutAnimation, Pressable, StyleSheet, View, type ViewProps } from "react-native";
import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import { alpha, PILL } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { Icon } from "./Icon";
import { icons } from "./icons";
import { Text } from "./Text";
import { BaseText } from "./internal/BaseText";
import { textStyle } from "./internal/typography";
import { run, useReducedMotion } from "./internal/motion";
import { WorkActivityMarker } from "./WorkActivityBlock";

const Mask = MaskedView as unknown as ComponentType<ViewProps & { maskElement: ReactElement }>;

export interface WorkActivityDisclosureProps {
  status: string; latest: string; previous?: string; hiddenCount: number; live: boolean; expanded: boolean;
  onToggle: () => void; label: string; detailsLabel: string; children: React.ReactNode;
}

export function WorkActivityDisclosure({ status, latest, previous, hiddenCount, live, expanded, onToggle, label, detailsLabel, children }: WorkActivityDisclosureProps) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const chevron = useRef(new Animated.Value(expanded ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) { chevron.setValue(expanded ? 1 : 0); return; }
    const animation = run(t, chevron, expanded ? 1 : 0, expanded ? "--motion-base" : "--motion-exit-base",
      expanded ? "--motion-ease-standard" : "--motion-ease-accelerate");
    animation.start();
    return () => animation.stop();
  }, [expanded, reduced, t, chevron]);
  const toggle = () => {
    if (!reduced) LayoutAnimation.configureNext({ duration: t.duration("--motion-base"), update: { type: "easeInEaseOut" },
      create: { type: "easeInEaseOut", property: "opacity" }, delete: { type: "easeInEaseOut", property: "opacity" } });
    onToggle();
  };
  return <View>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={label} onPress={toggle}
      hitSlop={Math.max(0, (44 - t.length("--typo-caption-line-height")) / 2)}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <View style={{ flex: 1 }}><Text variant="caption" lines={1}>{status}</Text></View>
        <Animated.View style={{ opacity: chevron, transform: reduced ? undefined : [{ translateY: chevron.interpolate({ inputRange: [0, 1], outputRange: [t.length("--motion-distance-xs"), 0] }) }] }}>
          <Icon glyph={icons.ChevronUp} size="sm" tone="secondary" />
        </Animated.View>
      </View>
      {!expanded ? <View style={{ paddingTop: t.length("--space-sm") }}>
        <ActivityTail key={live ? hiddenCount : undefined} latest={latest} previous={previous} hiddenCount={hiddenCount} live={live} />
      </View> : null}
    </Pressable>
    {expanded ? <View accessibilityLabel={detailsLabel} style={{ paddingTop: t.length("--space-sm") }}>{children}</View> : null}
  </View>;
}

function ActivityTail({ latest, previous, hiddenCount, live }: Pick<WorkActivityDisclosureProps, "latest" | "previous" | "hiddenCount" | "live">) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const enter = useRef(new Animated.Value(live && !reduced ? 0 : 1)).current;
  useEffect(() => {
    enter.setValue(live && !reduced ? 0 : 1);
    if (!live || reduced) return;
    const animation = run(t, enter, 1, "--motion-base", "--motion-ease-standard");
    animation.start();
    return () => animation.stop();
  }, [live, hiddenCount, reduced, t, enter]);
  const markerTop = 0.36 * t.length("--typo-caption-line-height");
  return <Animated.View style={{ gap: t.length("--space-xs"), opacity: enter,
    transform: reduced ? undefined : [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [t.length("--motion-distance-md"), 0] }) }] }}>
    {previous ? <View style={{ position: "absolute", left: 9, width: 1, top: t.length("--space-xs") / 2, bottom: t.length("--tag-height-sm") / 2 }}>
      <LinearGradient style={StyleSheet.absoluteFill} colors={[alpha(t.color("--line-strong"), 0), alpha(t.color("--line-strong"), 0.9)]} locations={[0, 0.7]} />
    </View> : null}
    {previous ? <Mask maskElement={<LinearGradient style={{ flex: 1 }} colors={["rgba(0, 0, 0, 0.2)", "rgba(0, 0, 0, 0.75)"]} />}>
      <View style={{ paddingLeft: 28 }}>
        <View style={{ position: "absolute", left: 9 - 3 }}><WorkActivityMarker top={markerTop} /></View>
        <Text variant="caption" tone="secondary" lines={1}>{previous}</Text>
      </View>
    </Mask> : null}
    <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 28, minHeight: t.length("--tag-height-sm"), gap: t.length("--space-xs") }}>
      <View style={{ position: "absolute", left: 9 - 3, top: 0 }}><WorkActivityMarker live={live} top={markerTop} /></View>
      <View style={{ flex: 1 }}><Text variant="caption" tone="secondary" lines={1}>{latest}</Text></View>
      {hiddenCount > 0 ? <View style={{ flexDirection: "row", alignItems: "center", height: t.length("--tag-height-sm"),
        paddingHorizontal: t.length("--tag-padding-inline-sm"), borderWidth: t.length("--border-hairline"), borderColor: t.color("--line"),
        backgroundColor: t.color("--surface"), borderRadius: t.length(PILL) }}>
        <BaseText style={{ ...textStyle(t, "caption"), fontSize: t.length("--font-size-1"), color: t.color("--text-secondary") }}>{`+${hiddenCount}`}</BaseText>
        <Icon glyph={icons.ChevronRight} size="xs" tone="secondary" />
      </View> : <Icon glyph={icons.ChevronRight} size="sm" tone="secondary" />}
    </View>
  </Animated.View>;
}
