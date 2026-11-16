import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, KeyboardAvoidingView, Modal, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTokens } from "../design/useTokens";
import { IconButton } from "./Button";
import { Text } from "./Text";
import { icons } from "./icons";
import { FadedScroll } from "./internal/FadedScroll";
import { GlassFill } from "./internal/GlassFill";
import { run, useReducedMotion } from "./internal/motion";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  closeLabel: string;
  dismissible?: boolean;
  testID?: string;
}

type PanelProps = Pick<SheetProps, "onClose" | "title" | "description" | "children" | "actions" | "closeLabel"> & {
  focusTitle?: boolean;
};

/** The sheet surface without the modal: exported for the gallery only. */
export function SheetPanel({ onClose, title, description, children, actions, closeLabel, focusTitle }: PanelProps) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const titleRef = useRef<React.ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (focusTitle && titleRef.current) AccessibilityInfo.sendAccessibilityEvent(titleRef.current, "focus");
  }, [focusTitle]);
  const radius = t.length("--adaptive-composer-radius");
  const space = t.length("--space-4");
  const pull = -(space - t.length("--space-2"));
  return (
    <View
      accessibilityViewIsModal
      style={{
        width: "100%",
        maxHeight: height - insets.top - t.length("--space-2xl"),
        borderTopLeftRadius: radius,
        borderTopRightRadius: radius,
        borderWidth: t.length("--border-hairline"),
        borderColor: t.color("--tinted-glass-border"),
        padding: space,
        paddingBottom: space + insets.bottom,
        gap: space,
      }}
    >
      <GlassFill radii={{ topLeft: radius, topRight: radius, bottomRight: 0, bottomLeft: 0 }} fadeBottom={false} />
      <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
        <View style={{ flex: 1, gap: t.length("--space-2") }}>
          <View ref={titleRef} accessible>
            <Text variant="panelTitle">{title}</Text>
          </View>
          {description ? <Text tone="secondary">{description}</Text> : null}
        </View>
        <View style={{ marginTop: pull, marginEnd: pull }}>
          <IconButton icon={icons.X} label={closeLabel} onPress={onClose} />
        </View>
      </View>
      {children ? <FadedScroll>{children}</FadedScroll> : null}
      {actions ? (
        <View style={{ flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: t.length("--space-2") }}>{actions}</View>
      ) : null}
    </View>
  );
}

export function Sheet({ open, onClose, dismissible = true, testID, ...panel }: SheetProps) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const { height } = useWindowDimensions();
  const [mounted, setMounted] = useState(open);
  const scrim = useRef(new Animated.Value(0)).current;
  const travel = useRef(new Animated.Value(reduced ? 0 : height)).current;
  const fade = useRef(new Animated.Value(reduced ? 0 : 1)).current;
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  useEffect(() => {
    if (!mounted) return;
    const enter = open;
    const motion = reduced
      ? [
          run(t, scrim, enter ? 1 : 0, enter ? "--motion-base" : "--motion-exit-slow", enter ? "--motion-ease-standard" : "--motion-ease-accelerate"),
          run(t, fade, enter ? 1 : 0, enter ? "--motion-fast" : "--motion-exit-fast", enter ? "--motion-ease-standard" : "--motion-ease-accelerate"),
        ]
      : [
          run(t, scrim, enter ? 1 : 0, enter ? "--motion-base" : "--motion-exit-slow", enter ? "--motion-ease-standard" : "--motion-ease-accelerate"),
          run(t, travel, enter ? 0 : height, enter ? "--adaptive-panel-duration" : "--motion-exit-slow", enter ? "--adaptive-panel-easing" : "--motion-ease-accelerate"),
        ];
    const animation = Animated.parallel(motion);
    animation.start(({ finished }) => {
      if (finished && !enter) setMounted(false);
    });
    return () => animation.stop();
  }, [open, mounted, reduced, t, height, scrim, travel, fade]);
  return (
    <Modal transparent animationType="none" statusBarTranslucent visible={mounted} onRequestClose={dismissible ? onClose : undefined} testID={testID}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.color("--dialog-overlay-bg"), opacity: scrim }]} />
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={dismissible ? onClose : undefined}
        accessibilityRole="button"
        accessibilityLabel={panel.closeLabel}
        accessibilityElementsHidden={!dismissible}
        importantForAccessibility={dismissible ? "auto" : "no-hide-descendants"}
      />
      <KeyboardAvoidingView behavior="padding" pointerEvents="box-none" style={[StyleSheet.absoluteFill, { justifyContent: "flex-end" }]}>
        <Animated.View style={{ opacity: fade, transform: [{ translateY: travel }] }}>
          <SheetPanel {...panel} onClose={onClose} focusTitle={open} />
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
