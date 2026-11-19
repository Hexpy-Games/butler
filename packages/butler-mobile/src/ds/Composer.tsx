import { useEffect, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RADIUS } from "../design/tokens";
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
  testID?: string;
}
export interface ComposerDockProps { children: React.ReactNode; onHeightChange?: (height: number) => void }

// Eight input lines before the input scrolls (web `8lh`), and the toolbar's 2px button gap.
const MAX_LINES = 8;
const TOOLBAR_GAP = 2;

export function Composer({
  value, onChangeText, placeholder, canSend, onSend, mode = "send", onStop, busy, disabled, attach,
  sendLabel, stopLabel, adjunct, testID,
}: ComposerProps) {
  const t = useTokens();
  const radius = t.length(RADIUS);
  const divider = t.color("--composer-glass-divider");
  const lineHeight = useScaledLine(t.length("--typo-body-line-height"));
  const padding = t.length("--space-3");
  return (
    <View
      style={{
        borderRadius: radius,
        borderWidth: liquidGlass ? 0 : t.length("--border-hairline"),
        borderColor: t.color("--tinted-glass-border"),
        boxShadow: glassShadow(t),
      }}
    >
      <GlassFill radii={{ topLeft: radius, topRight: radius, bottomRight: radius, bottomLeft: radius }} />
      {adjunct ? (
        <View style={{ borderColor: divider, borderBottomWidth: t.length("--border-hairline") }}>{adjunct}</View>
      ) : null}
      <TextInput
        multiline
        lineBreakStrategyIOS="hangul-word"
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.color("--placeholder")}
        editable={!disabled}
        testID={testID}
        accessibilityLabel={placeholder}
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
      <View
        style={{
          borderColor: divider,
          borderTopWidth: t.length("--border-hairline"),
          flexDirection: "row",
          alignItems: "center",
          minHeight: t.length("--control-hit-target"),
          padding: t.length("--space-xs"),
          gap: TOOLBAR_GAP,
        }}
      >
        {attach ? <IconButton icon={icons.Plus} label={attach.label} onPress={attach.onPress} disabled={disabled} /> : null}
        <View style={{ flex: 1 }} />
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
export function ComposerDock({ children, onHeightChange }: ComposerDockProps) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", () => setKeyboard(true));
    const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboard(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const gap = t.length("--space-sm");
  return (
    <KeyboardAvoidingView behavior="padding" pointerEvents="box-none" style={[StyleSheet.absoluteFill, { justifyContent: "flex-end" }]}>
      <View
        onLayout={(event) => onHeightChange?.(event.nativeEvent.layout.height)}
        style={{ paddingHorizontal: t.length("--adaptive-composer-inset"), paddingBottom: keyboard ? gap : insets.bottom + gap }}
      >
        {children}
      </View>
    </KeyboardAvoidingView>
  );
}
