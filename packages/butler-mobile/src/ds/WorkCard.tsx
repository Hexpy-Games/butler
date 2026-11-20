import { useEffect, useRef, useState } from "react";
import { Animated, View } from "react-native";
import { useTokens } from "../design/useTokens";
import { Badge } from "./Badge";
import { IconButton } from "./Button";
import { Icon } from "./Icon";
import { icons } from "./icons";
import { SpinnerArc } from "./Spinner";
import { Surface } from "./Surface";
import { Text } from "./Text";
import { run, useReducedMotion } from "./internal/motion";
import { AnimatedPressable, usePress } from "./internal/press";

export interface WorkCardProps {
  title: string; status: string; tone: "accent" | "success" | "danger" | "neutral";
  latest: string | null; live: boolean; details: string[];
  onOpen?: () => void; openLabel?: string; disclosureLabel: string;
}

export function WorkCard({ title, status, tone, latest, live, details, onOpen, openLabel, disclosureLabel }: WorkCardProps) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const press = usePress({ scale: true });
  const [expanded, setExpanded] = useState(false);
  const rotation = useRef(new Animated.Value(0)).current;
  const reveal = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) rotation.setValue(expanded ? 1 : 0);
    else run(t, rotation, expanded ? 1 : 0, "--motion-fast", "--motion-ease-standard").start();
    reveal.setValue(expanded && reduced ? 1 : 0);
    if (expanded && !reduced) run(t, reveal, 1, "--motion-fast", "--motion-ease-standard").start();
  }, [expanded, reduced, rotation, reveal, t]);
  const titleText = <View style={{ flex: 1 }}><Text weight="medium" lines={1}>{title}</Text></View>;
  return <Surface variant="card" padding="lg">
    <View style={{ gap: t.length("--space-2") }}>
      {onOpen ? <AnimatedPressable accessibilityRole="button" accessibilityLabel={openLabel} onPress={onOpen}
        {...press.handlers} style={[{ flexDirection: "row", alignItems: "center", opacity: press.opacity,
          boxShadow: press.focused ? t.shadow("--focus-ring") : undefined }, press.scaleStyle]}>
        {titleText}<Icon glyph={icons.ChevronRight} size="sm" tone="tertiary" />
      </AnimatedPressable> : titleText}
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-2") }}>
        <Badge label={status} tone={tone} />
        {live ? <SpinnerArc size={t.length("--icon-size-sm")} color={t.color("--text-secondary")} /> : null}
        <View style={{ flex: 1 }}><Text variant="caption" tone="secondary" lines={1}>{latest}</Text></View>
        {details.length > 0 ? <Animated.View style={{ transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "180deg"] }) }] }}>
          <IconButton size="sm" variant="ghost" icon={icons.ChevronDown} label={disclosureLabel} onPress={() => setExpanded(value => !value)} />
        </Animated.View> : null}
      </View>
      {expanded ? <Animated.View style={{ gap: t.length("--space-1"), opacity: reduced ? 1 : reveal,
        transform: reduced ? undefined : [{ translateY: reveal.interpolate({ inputRange: [0, 1], outputRange: [t.length("--motion-distance-sm"), 0] }) }] }}>
        {details.map((detail, index) => <Text key={index} variant="caption" tone="secondary">{detail}</Text>)}
      </Animated.View> : null}
    </View>
  </Surface>;
}
