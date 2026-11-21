import { useEffect, useId, useRef } from "react";
import { Animated, Pressable, View } from "react-native";
import Svg, { Defs, G, Pattern, Rect } from "react-native-svg";
import { useTokens } from "../design/useTokens";
import { run, useReducedMotion } from "./internal/motion";
import { Text } from "./Text";

export interface UsageBarsSegment { id: string; value: number; subtask?: number }
export interface UsageBarsBucket { key: string; segments: UsageBarsSegment[] }
export interface UsageBarsProps {
  buckets: UsageBarsBucket[];
  series: { id: string; color: "--context-chart-1" | "--context-chart-2" | "--context-chart-5" }[];
  axisLabels: { index: number; text: string }[];
  selectedIndex: number | null;
  onSelect(index: number | null): void;
  state: "loading" | "ready";
  emptyLabel: string;
  loadingLabel: string;
  note?: string;
  accessibilityLabel: string;
}
const PLOT_HEIGHT = 56;

export function UsageBars({ buckets, series, axisLabels, selectedIndex, onSelect, state, emptyLabel, loadingLabel, note, accessibilityLabel }: UsageBarsProps) {
  const t = useTokens();
  const sums = buckets.map(bucket => bucket.segments.reduce((sum, segment) => sum + segment.value, 0));
  const max = Math.max(1, ...sums);
  return <View style={{ gap: t.length("--space-1") }} accessibilityLabel={accessibilityLabel}>
    {state === "loading" || sums.every(sum => sum === 0)
      ? <View style={{ height: PLOT_HEIGHT, justifyContent: "center" }}><Text variant="caption" tone="tertiary">{state === "loading" ? loadingLabel : emptyLabel}</Text></View>
      : <View style={{ flexDirection: "row", gap: t.length("--space-xs"), height: PLOT_HEIGHT }}>
        {buckets.map((bucket, index) => <UsageColumn key={bucket.key} bucket={bucket} series={series} max={max}
          dimmed={selectedIndex !== null && selectedIndex !== index} onPress={() => onSelect(selectedIndex === index ? null : index)} />)}
      </View>}
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      {axisLabels.map(({ index, text }) => <View key={index} style={{ flex: 1 }}>
        <Text variant="caption" tone="tertiary" align={index === 0 ? "start" : index === buckets.length - 1 ? "end" : "center"}>{text}</Text>
      </View>)}
    </View>
    {note ? <Text variant="caption" tone="tertiary">{note}</Text> : null}
  </View>;
}

function UsageColumn({ bucket, series, max, dimmed, onPress }: {
  bucket: UsageBarsBucket; series: UsageBarsProps["series"]; max: number; dimmed: boolean; onPress(): void;
}) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const instance = useId().replace(/[^A-Za-z0-9_-]/gu, "-");
  const opacity = useRef(new Animated.Value(dimmed ? 0.4 : 1)).current;
  useEffect(() => {
    if (reduced) opacity.setValue(dimmed ? 0.4 : 1);
    else run(t, opacity, dimmed ? 0.4 : 1, "--motion-fast", "--motion-ease-standard").start();
  }, [dimmed, reduced, t, opacity]);
  let bottom = PLOT_HEIGHT;
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={bucket.key} style={{ flex: 1, height: PLOT_HEIGHT }}>
    <Animated.View style={{ opacity }}>
      <Svg width="100%" height={PLOT_HEIGHT}>
        <Defs>{series.map(item => <Pattern key={item.id} id={`${instance}-${item.id}`} patternUnits="userSpaceOnUse"
          width={4} height={4} patternTransform="rotate(45)">
          <Rect width={2} height={4} fill={t.color(item.color)} />
        </Pattern>)}</Defs>
        {series.map(item => {
          const segment = bucket.segments.find(segment => segment.id === item.id);
          const height = (segment?.value ?? 0) / max * PLOT_HEIGHT;
          const subtask = (segment?.subtask ?? 0) / max * PLOT_HEIGHT;
          bottom -= height;
          return <G key={item.id}>
            <Rect y={bottom + subtask} width="100%" height={height - subtask} fill={t.color(item.color)} />
            <Rect y={bottom} width="100%" height={subtask} fill={`url(#${instance}-${item.id})`} />
          </G>;
        })}
      </Svg>
    </Animated.View>
  </Pressable>;
}
