import React, { useContext, useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { RADIUS } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { BaseText } from "./internal/BaseText";
import { icons, type IconGlyph } from "./icons";
import { IconSlot, useScaledLine } from "./internal/IconSlot";
import { GroupDivider, InListGroup } from "./internal/listGroup";
import { run, useReducedMotion } from "./internal/motion";
import { usePress } from "./internal/press";
import { fontStyle, maxFontScale, textStyle, weightValue } from "./internal/typography";

export interface ListRowProps {
  title: string;
  description?: string;
  meta?: string;
  icon?: IconGlyph | React.ReactElement;
  trailing?: React.ReactNode;
  disclosure?: { expanded: boolean };
  onPress?: () => void;
  /** Opens the row's actions; also offered to screen readers as the "longpress" action. */
  onLongPress?: () => void;
  selected?: boolean;
  disabled?: boolean;
  /** Danger-toned title and icon, for a destructive action row. */
  destructive?: boolean;
  titleLines?: 1 | 2;
  descriptionLines?: 1 | 2 | 3;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

export function ListRow({
  title, description, meta, icon, trailing, onPress, onLongPress, selected, disabled, destructive, titleLines = 1, descriptionLines = 2,
  accessibilityLabel, accessibilityHint, testID, disclosure,
}: ListRowProps) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const grouped = useContext(InListGroup);
  const press = usePress({ scale: false, disabled: disabled || (!onPress && !onLongPress) });
  const filled = press.pressed || !!selected;
  const underlay = useRef(new Animated.Value(filled ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) underlay.setValue(filled ? 1 : 0);
    else run(t, underlay, filled ? 1 : 0, filled ? "--motion-instant" : "--motion-fast", "--motion-ease-standard").start();
  }, [filled, reduced, t, underlay]);
  const expanded = disclosure?.expanded ?? false;
  const rotation = useRef(new Animated.Value(expanded ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) rotation.setValue(expanded ? 1 : 0);
    else run(t, rotation, expanded ? 1 : 0, "--motion-fast", "--motion-ease-standard").start();
  }, [expanded, reduced, rotation, t]);

  const titleLine = t.length("--typo-app-title-line-height");
  const trailingHeight = useScaledLine(titleLine);
  const radius = grouped ? 0 : t.length(RADIUS);
  const padX = t.length(grouped ? "--space-4" : "--space-sm");
  const fg = (key: "--text-primary" | "--text-secondary" | "--text-tertiary") =>
    t.color(disabled ? "--interactive-disabled-fg" : key);
  const titleColor = disabled ? t.color("--interactive-disabled-fg") : t.color(destructive ? "--color-danger-text" : "--text-primary");
  const titleText = (
    <BaseText
      numberOfLines={titleLines}
      ellipsizeMode="tail"
      maxFontSizeMultiplier={maxFontScale.control}
      style={{
        ...fontStyle(t.length("--font-size-4"), titleLine, weightValue(t, selected ? "medium" : "regular")),
        color: titleColor, flexShrink: 1, ...(disclosure ? {} : { flexGrow: 1, flexBasis: "50%" }),
      }}
    >
      {title}
    </BaseText>
  );

  const body = (
    <>
      {grouped ? <GroupDivider inset={padX + (icon ? t.length("--sidebar-icon-size") + t.length("--sidebar-row-gap") : 0)} /> : null}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderRadius: radius, backgroundColor: t.color("--selection-strong"), opacity: underlay }]}
      />
      {icon ? (
        <View style={{ opacity: 0.82 }}>
          <IconSlot size={t.length("--sidebar-icon-size")} lineHeight={titleLine}>
            {React.isValidElement(icon) ? icon : <HugeiconsIcon icon={icon} size={t.length("--sidebar-icon-size")} color={titleColor} />}
          </IconSlot>
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <View
          style={{
            flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center",
            columnGap: t.length("--space-md"), rowGap: t.length("--space-xs"),
          }}
        >
          {disclosure ? (
            <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: "50%", flexDirection: "row", alignItems: "center", gap: t.length("--space-1") }}>
              {titleText}
              <Animated.View style={{ transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "90deg"] }) }] }}>
                <HugeiconsIcon icon={icons.ChevronRight} size={t.length("--sidebar-icon-size")} color={fg("--text-tertiary")} />
              </Animated.View>
            </View>
          ) : titleText}
          {meta ? (
            <BaseText
              maxFontSizeMultiplier={maxFontScale.control}
              style={{ ...textStyle(t, "caption"), color: fg("--text-tertiary"), flexShrink: 1, fontVariant: ["tabular-nums"] }}
            >
              {meta}
            </BaseText>
          ) : null}
        </View>
        {description ? (
          <BaseText
            numberOfLines={descriptionLines}
            ellipsizeMode="tail"
            maxFontSizeMultiplier={maxFontScale.control}
            style={{ ...textStyle(t, "caption"), color: fg("--text-secondary"), marginTop: t.length("--space-xs") }}
          >
            {description}
          </BaseText>
        ) : null}
      </View>
      {trailing ? <View style={{ height: trailingHeight, justifyContent: "center" }}>{trailing}</View> : null}
    </>
  );

  const container = {
    flexDirection: "row",
    alignItems: "flex-start",
    minHeight: t.length("--sidebar-row-height"),
    paddingVertical: t.length("--space-md"),
    paddingHorizontal: padX,
    columnGap: t.length("--sidebar-row-gap"),
    borderRadius: radius,
    boxShadow: press.focused ? t.shadow("--focus-ring").map(s => (grouped ? { ...s, inset: true } : s)) : undefined,
  } as const;

  if (!onPress && !onLongPress) return <View style={container} testID={testID}>{body}</View>;
  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? [title, description, meta].filter(Boolean).join(", ")}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: !!selected, disabled: !!disabled, ...(disclosure ? { expanded } : {}) }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityActions={onLongPress ? [{ name: "longpress" }] : undefined}
      onAccessibilityAction={event => { if (event.nativeEvent.actionName === "longpress") onLongPress?.(); }}
      {...press.handlers}
      style={container}
    >
      {body}
    </Pressable>
  );
}
