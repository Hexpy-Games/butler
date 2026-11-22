import { ScrollEdgeEffect } from "@bsky.app/expo-scroll-edge-effect";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useRef, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { alpha, RADIUS } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { IconButton } from "./Button";
import { icons } from "./icons";
import { GlassFill, glassShadow, liquidGlass } from "./internal/GlassFill";
import { useScaledLine } from "./internal/IconSlot";
import { SendButton } from "./internal/SendButton";
import { fontFace, maxFontScale } from "./internal/typography";

export interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  canSend: boolean;
  onSend: () => void;
  mode?: "send" | "stop";
  onStop?: () => void;
  busy?: boolean;
  disabled?: boolean;
  attach?: { label: string; onPress: () => void };
  sendLabel: string;
  stopLabel: string;
  adjunct?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  attachments?: React.ReactNode;
  testID?: string;
}
export interface ComposerDockProps {
  children: React.ReactNode;
  /** height: the dock; keyboard: how much of the dock's frame the keyboard covers (0 when hidden). */
  onHeightChange?: (height: number, keyboard: number) => void;
  /** Android only: fills the dock area, with a fade above it, while content scrolls beneath; iOS uses the native scroll edge effect. */
  backdrop?: { color: string; visible: boolean };
}

// Eight input lines before the input scrolls (web `8lh`).
const MAX_LINES = 8;

export function Composer({
  value, onChangeText, placeholder, canSend, onSend, mode = "send", onStop, busy, disabled, attach,
  sendLabel, stopLabel, adjunct, leading, trailing, attachments, testID,
}: ComposerProps) {
  const t = useTokens();
  const radius = t.length(RADIUS);
  const divider = t.color("--composer-glass-divider");
  const lineHeight = useScaledLine(t.length("--typo-body-line-height"));
  const padding = t.length("--space-3");
  return (
    <View style={{ borderRadius: radius, borderWidth: liquidGlass ? 0 : t.length("--border-hairline"),
      borderColor: t.color("--tinted-glass-border"), boxShadow: glassShadow(t) }}>
      <GlassFill radii={{ topLeft: radius, topRight: radius, bottomRight: radius, bottomLeft: radius }} />
      {adjunct ? (
        <View style={{ borderColor: divider, borderBottomWidth: t.length("--border-hairline") }}>{adjunct}</View>
      ) : null}
      <TextInput
        multiline lineBreakStrategyIOS="hangul-word" value={value} onChangeText={onChangeText} placeholder={placeholder}
        placeholderTextColor={t.color("--placeholder")}
        editable={!disabled} testID={testID} accessibilityLabel={placeholder}
        maxFontSizeMultiplier={maxFontScale.control}
        textAlignVertical="top"
        style={{
          paddingVertical: padding,
          paddingHorizontal: t.length("--space-4"),
          minHeight: lineHeight + 2 * padding,
          maxHeight: MAX_LINES * lineHeight + 2 * padding,
          color: t.color("--text-primary"),
          fontFamily: fontFace(t.number("--font-weight-regular")),
          fontSize: t.length("--typo-body-size"),
          lineHeight: t.length("--typo-body-line-height"),
        }}
      />
      {attachments}
      <View style={{ borderColor: divider, borderTopWidth: t.length("--border-hairline"),
        flexDirection: "row", alignItems: "center",
        padding: t.length("--space-2"), gap: t.length("--space-2") }}>
        {attach ? <IconButton size="control" icon={icons.Plus} label={attach.label} onPress={attach.onPress} disabled={disabled} /> : null}
        {leading}
        <View style={{ flex: 1, minWidth: t.length("--space-2") }} />
        {trailing}
        <SendButton
          mode={mode}
          enabled={canSend && !disabled}
          busy={!!busy}
          label={mode === "stop" ? stopLabel : sendLabel}
          onPress={mode === "stop" ? (onStop ?? (() => {})) : onSend}
        />
      </View>
    </View>
  );
}

/** Keyboard and safe-area placement; the Composer itself has no position. */
export function ComposerDock({ children, onHeightChange, backdrop }: ComposerDockProps) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  // KeyboardAvoidingView measures from its parent, not the window; offset by where the dock's frame starts on screen.
  const frame = useRef<View>(null);
  const [top, setTop] = useState(0);
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const [frameHeight, setFrameHeight] = useState(0);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (event) => setKeyboardTop(event.endCoordinates.screenY));
    const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboardTop(null));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const covered = keyboardTop === null ? 0 : Math.max(0, top + frameHeight - keyboardTop);
  useEffect(() => { onHeightChange?.(height, covered); }, [height, covered]);
  const gap = t.length("--space-sm");
  const fade = t.length("--tinted-glass-edge-size");
  return (
    <View ref={frame} pointerEvents="box-none" style={StyleSheet.absoluteFill}
      onLayout={(event) => {
        setFrameHeight(event.nativeEvent.layout.height);
        frame.current?.measureInWindow((_x, y) => setTop(y));
      }}>
      <KeyboardAvoidingView behavior="padding" pointerEvents="box-none" keyboardVerticalOffset={top}
        style={[StyleSheet.absoluteFill, { justifyContent: "flex-end" }]}>
        <ScrollEdgeEffect edge="bottom" effect="soft">
          <View
            onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
            style={{ paddingHorizontal: t.length("--adaptive-composer-inset"), paddingBottom: keyboardTop !== null ? gap : insets.bottom + gap }}
          >
            {backdrop?.visible && Platform.OS === "android" && (
              <View pointerEvents="none" style={[StyleSheet.absoluteFill, { top: -fade }]}>
                <LinearGradient colors={[alpha(backdrop.color, 0), backdrop.color]} style={{ height: fade }} />
                <View style={{ flex: 1, backgroundColor: backdrop.color }} />
              </View>
            )}
            {children}
          </View>
        </ScrollEdgeEffect>
      </KeyboardAvoidingView>
    </View>
  );
}
