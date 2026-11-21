import { Fragment, useEffect, useRef } from "react";
import { Animated, View } from "react-native";
import { alpha, PILL } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { Text } from "./Text";
import { BaseText } from "./internal/BaseText";
import { textStyle } from "./internal/typography";
import { toEasing, useReducedMotion } from "./internal/motion";
import { WorkActivityTools, type WorkActivityToolItem } from "./WorkActivityTools";

// Desktop WorkActivityBlock.module.css:1-31; marker 7, border 1, line 1.
export const WORK_GEOMETRY = {
  normal: { lineX: 15, contentX: 44, lineStart: 8, bridge: "--space-4" },
  compact: { lineX: 9, contentX: 28, lineStart: 6, bridge: "--space-3" },
} as const;

export function WorkActivityMarker({ live = false, top }: { live?: boolean; top: number }) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    opacity.setValue(1);
    if (!live || reduced) return;
    const leg = (toValue: number) => Animated.timing(opacity, { toValue,
      duration: t.duration("--motion-live-pulse") / 2, easing: toEasing(t.easing("--motion-ease-standard")), useNativeDriver: true });
    const loop = Animated.loop(Animated.sequence([leg(0.35), leg(1)]));
    loop.start();
    return () => loop.stop();
  }, [live, reduced, t, opacity]);
  return <Animated.View style={{ position: "absolute", top, width: 7, height: 7, opacity,
    borderWidth: t.length("--border-hairline"), borderRadius: t.length(PILL),
    borderColor: t.color(live ? "--text-primary" : "--line-strong"), backgroundColor: t.color(live ? "--text-primary" : "--surface") }} />;
}

export interface WorkActivityBlockProps {
  title: string; description?: (string | React.ReactElement)[]; live?: boolean; connected?: boolean; last?: boolean;
  density?: "normal" | "compact"; tools?: WorkActivityToolItem[];
  renderAfter?: (tool: WorkActivityToolItem) => React.ReactNode;
}

export function WorkActivityBlock({ title, description, live, connected, last = true, density = "normal", tools = [], renderAfter }: WorkActivityBlockProps) {
  const t = useTokens();
  const compact = density === "compact";
  const geometry = WORK_GEOMETRY[density];
  const variant = compact ? "caption" : "body";
  const lineHeight = t.length(compact ? "--typo-caption-line-height" : "--typo-body-line-height");
  return <View style={{ paddingLeft: geometry.contentX, gap: t.length(compact ? "--space-xs" : "--space-sm") }}>
    <View style={{ position: "absolute", left: geometry.lineX, width: 1, top: geometry.lineStart,
      bottom: connected || !last ? -(t.length(geometry.bridge) + geometry.lineStart) : -2, backgroundColor: alpha(t.color("--line"), 0.82) }} />
    <View>
      <View style={{ position: "absolute", left: -geometry.contentX + geometry.lineX - 3 }}>
        <WorkActivityMarker live={live} top={(compact ? 0.36 : 0.4) * lineHeight} />
      </View>
      <Text variant={variant} tone="secondary">{title}</Text>
    </View>
    {description?.length ? <View style={{ gap: t.length("--space-xs") }}>
      {description.map((line, index) => <Fragment key={index}>{typeof line === "string"
        ? <BaseText style={{ ...textStyle(t, variant), color: alpha(t.color("--text-tertiary"), 0.78) }}>{line}</BaseText> : line}</Fragment>)}
    </View> : null}
    {tools.length ? <WorkActivityTools tools={tools} compact={compact} renderAfter={renderAfter} /> : null}
  </View>;
}
