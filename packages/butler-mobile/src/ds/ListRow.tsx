import React, { useContext, useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { RADIUS } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { BaseText } from "./internal/BaseText";
import { icons, type IconGlyph } from "./icons";
import { IconSlot, useScaledLine } from "./internal/IconSlot";
import { GroupDivider, GROUP_INNER_GAP, InListGroup } from "./internal/listGroup";
import { run, useReducedMotion } from "./internal/motion";
import { usePress } from "./internal/press";
import { SelectionMark } from "./internal/SelectionMark";
import { fontStyle, maxFontScale, textStyle, weightValue } from "./internal/typography";

export interface ListRowProps {
  title: string;
  description?: string;
  meta?: string;
  icon?: IconGlyph | React.ReactElement;
  trailing?: React.ReactNode;
  disclosure?: { expanded: boolean };
  /** Pushes a deeper page; ListRow draws the trailing chevron. Leave unset for pickers, toggles and actions. */
  navigates?: boolean;
  onPress?: () => void;
  /** Opens the row's actions; also offered to screen readers as the "longpress" action. */
  onLongPress?: () => void;
  selected?: boolean;
  /** Draws a leading radio (single) or check (multi) control that follows `selected`. Takes the leading icon slot; do not pass `icon` with it. */
  selection?: "single" | "multi";
  disabled?: boolean;
  /** Danger-toned title and icon, for a destructive action row. */
  destructive?: boolean;
  /** Accent-toned title for a neutral action row (e.g. "Check for updates"). */
  accent?: boolean;
  titleLines?: 1 | 2;
  descriptionLines?: 1 | 2 | 3;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

export function ListRow({
  title, description, meta, icon, trailing, onPress, onLongPress, selected, disabled, destructive, accent, titleLines = 1, descriptionLines = 2,
  accessibilityLabel, accessibilityHint, testID, disclosure, navigates, selection,
}: ListRowProps) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const grouped = useContext(InListGroup);
  const press = usePress({ scale: false, disabled: disabled || (!onPress && !onLongPress) });
  const filled = press.pressed || (!!selected && !grouped);
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
  // Grouped: 20 inset, 16 + 24 + 16 = 56 one-line height, 20 glyph, 14 gap. Loose: 8 inset, 12 + 24 + 12 = 48, 22 glyph, 12 gap.
  const padX = t.length(grouped ? "--space-5" : "--space-sm");
  const padY = t.length(grouped ? "--space-4" : "--space-md");
  const iconSize = t.length(grouped ? "--icon-size-lg" : "--sidebar-icon-size");
  const iconGap = grouped ? GROUP_INNER_GAP : t.length("--sidebar-row-gap");
  const fg = (key: "--text-primary" | "--text-secondary" | "--text-tertiary") =>
    t.color(disabled ? "--interactive-disabled-fg" : key);
  const titleColor = disabled ? t.color("--interactive-disabled-fg") : t.color(destructive ? "--color-danger-text" : accent ? "--accent-text" : "--text-primary");
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
      {grouped ? <GroupDivider inset={padX + (selection || icon ? iconSize + iconGap : 0)} /> : null}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderRadius: radius, backgroundColor: t.color("--selection-strong"), opacity: underlay }]}
      />
      {selection ? (
        <IconSlot size={iconSize} lineHeight={titleLine}><SelectionMark kind={selection} selected={!!selected} disabled={!!disabled} size={iconSize} /></IconSlot>
      ) : icon ? (
        <View style={{ opacity: 0.82 }}>
          <IconSlot size={iconSize} lineHeight={titleLine}>
            {React.isValidElement(icon) ? icon : <HugeiconsIcon icon={icon} size={iconSize} color={titleColor} />}
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
                <HugeiconsIcon icon={icons.ChevronRight} size={iconSize} color={fg("--text-tertiary")} />
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
      {trailing || navigates ? (
        <View style={{ height: trailingHeight, flexDirection: "row", alignItems: "center", gap: t.length("--space-2") }}>
          {trailing}
          {navigates ? <HugeiconsIcon icon={icons.ChevronRight} size={t.length(grouped ? "--icon-size-lg" : "--icon-size-md")} color={fg("--text-tertiary")} /> : null}
        </View>
      ) : null}
    </>
  );

  const container = {
    flexDirection: "row",
    alignItems: "flex-start",
    minHeight: titleLine + 2 * padY,
    paddingVertical: padY,
    paddingHorizontal: padX,
    columnGap: iconGap,
    borderRadius: radius,
    boxShadow: press.focused ? t.shadow("--focus-ring").map(s => (grouped ? { ...s, inset: true } : s)) : undefined,
  } as const;

  const selectionAccessibility = selection ? {
    accessibilityRole: selection === "single" ? "radio" as const : "checkbox" as const,
    accessibilityState: { checked: !!selected, disabled: !!disabled },
  } : undefined;
  if (!onPress && !onLongPress) return <View style={container} testID={testID}>{body}</View>;
  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? [title, description, meta].filter(Boolean).join(", ")}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: !!selected, disabled: !!disabled, ...(disclosure ? { expanded } : {}) }}
      {...selectionAccessibility}
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
