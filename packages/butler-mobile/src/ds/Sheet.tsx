import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, KeyboardAvoidingView, Modal, PanResponder, Pressable, StyleSheet, useWindowDimensions, View, type GestureResponderHandlers } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PILL, RADIUS } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { Button } from "./Button";
import { ButtonGroup } from "./ButtonGroup";
import { Text } from "./Text";
import { FadedScroll } from "./internal/FadedScroll";
import { GlassFill, liquidGlass } from "./internal/GlassFill";
import { run, useReducedMotion } from "./internal/motion";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  /** The one primary Button. Sheet pairs it with Cancel: [Cancel | action]. */
  action?: React.ReactElement;
  /** Label of the Cancel button, which closes the sheet; also the scrim's accessibility label. */
  cancelLabel: string;
  dismissible?: boolean;
  testID?: string;
}

type PanelProps = Pick<SheetProps, "onClose" | "title" | "description" | "children" | "action" | "cancelLabel"> & {
  focusTitle?: boolean;
  drag?: GestureResponderHandlers;
};

/** The sheet surface without the modal: exported for the gallery only. */
export function SheetPanel({ onClose, title, description, children, action, cancelLabel, focusTitle, drag }: PanelProps) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const titleRef = useRef<React.ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (focusTitle && titleRef.current) AccessibilityInfo.sendAccessibilityEvent(titleRef.current, "focus");
  }, [focusTitle]);
  const radius = t.length(RADIUS);
  const space = t.length("--space-4");
  return (
    <View
      accessibilityViewIsModal
      style={{
        width: "100%",
        maxHeight: height - insets.top - t.length("--space-2xl"),
        borderTopLeftRadius: radius,
        borderTopRightRadius: radius,
        borderWidth: liquidGlass ? 0 : t.length("--border-hairline"),
        borderColor: t.color("--tinted-glass-border"),
        padding: space,
        paddingBottom: space + insets.bottom,
        gap: space,
      }}
    >
      <GlassFill radii={{ topLeft: radius, topRight: radius, bottomRight: 0, bottomLeft: 0 }} />
      <View
        {...drag}
        style={{
          marginTop: -space, marginHorizontal: -space,
          paddingTop: space - t.length("--space-2"), paddingHorizontal: space,
          gap: space,
        }}
      >
        <View style={{ alignItems: "center", paddingBottom: t.length("--space-1") }}>
          <View accessibilityElementsHidden importantForAccessibility="no"
            style={{ width: t.length("--space-2xl") + t.length("--space-3"), height: t.length("--space-1"),
              borderRadius: t.length(PILL), backgroundColor: t.color("--color-border-strong") }} />
        </View>
        <View style={{ gap: t.length("--space-2") }}>
          <View ref={titleRef} accessible>
            <Text variant="panelTitle">{title}</Text>
          </View>
          {description ? <Text tone="secondary">{description}</Text> : null}
        </View>
      </View>
      {children ? <FadedScroll>{children}</FadedScroll> : null}
      {action
        ? <ButtonGroup layout="pair"><Button variant="secondary" label={cancelLabel} onPress={onClose} />{action}</ButtonGroup>
        : <ButtonGroup><Button variant="secondary" label={cancelLabel} onPress={onClose} /></ButtonGroup>}
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
  const close = useRef(onClose);
  close.current = onClose;
  const drag = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_, g) => travel.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_, g) => {
      if (g.dy > height / 6 || g.vy > 0.5) close.current();
      else run(t, travel, 0, "--motion-fast", "--motion-ease-standard").start();
    },
    onPanResponderTerminate: () => run(t, travel, 0, "--motion-fast", "--motion-ease-standard").start(),
  })).current;
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  useEffect(() => {
    if (!mounted) return;
    const enter = open;
    if (reduced) travel.setValue(0);
    else fade.setValue(1);
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
        accessibilityLabel={panel.cancelLabel}
        accessibilityElementsHidden={!dismissible}
        importantForAccessibility={dismissible ? "auto" : "no-hide-descendants"}
      />
      <KeyboardAvoidingView behavior="padding" pointerEvents="box-none" style={[StyleSheet.absoluteFill, { justifyContent: "flex-end" }]}>
        <Animated.View style={{ opacity: fade, transform: [{ translateY: travel }] }}>
          <SheetPanel {...panel} onClose={onClose} focusTitle={open} drag={dismissible ? drag.panHandlers : undefined} />
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
