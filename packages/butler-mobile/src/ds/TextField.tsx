import { useContext, useState } from "react";
import { TextInput, View } from "react-native";
import { alpha, mix, RADIUS } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { BaseText } from "./internal/BaseText";
import { Text } from "./Text";
import { ForcedState } from "./internal/press";
import { fontFace, maxFontScale, textStyle } from "./internal/typography";

export interface TextFieldProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  description?: string;
  error?: string;
  disabled?: boolean;
  literal?: boolean;
  numeric?: "tabular";
  autoFocus?: boolean;
  multiline?: boolean;
  keyboardType?: "default" | "url" | "number-pad";
  autoComplete?: "off" | "url" | "one-time-code";
  returnKeyType?: "done" | "go" | "next";
  onSubmitEditing?: () => void;
  maxLength?: number;
  testID?: string;
}

export function TextField({
  label, value, onChangeText, placeholder, description, error, disabled, literal, numeric, autoFocus,
  multiline, keyboardType, autoComplete, returnKeyType, onSubmitEditing, maxLength, testID,
}: TextFieldProps) {
  const t = useTokens();
  const [focusedNow, setFocusedNow] = useState(false);
  const forced = useContext(ForcedState);
  const focused = focusedNow || forced === "focused";
  const line = t.color("--line");
  const border = error
    ? t.color("--color-danger-border")
    : focused ? mix(t.color("--accent"), 0.52, line) : line;
  const fontVariant = [
    ...(numeric ? (["tabular-nums"] as const) : []),
    ...(literal ? (["no-common-ligatures", "no-contextual"] as const) : []),
  ];
  return (
    <View style={{ gap: t.length("--space-2") }}>
      <Text variant="label">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.color("--placeholder")}
        editable={!disabled}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        textAlignVertical={multiline ? "top" : undefined}
        keyboardType={keyboardType}
        autoComplete={autoComplete}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        maxLength={maxLength}
        onFocus={() => setFocusedNow(true)}
        onBlur={() => setFocusedNow(false)}
        testID={testID}
        accessibilityLabel={label}
        accessibilityHint={error ?? description}
        maxFontSizeMultiplier={maxFontScale.control}
        style={{
          minHeight: multiline ? 5 * t.length("--typo-body-line-height") : t.length("--control-hit-target"),
          paddingVertical: (t.length("--control-hit-target") - t.length("--typo-body-line-height")) / 2,
          paddingHorizontal: t.length("--space-md"),
          borderRadius: t.length(RADIUS),
          borderWidth: t.length("--border-hairline"),
          borderColor: border,
          backgroundColor: disabled ? t.color("--color-disabled-bg") : alpha(t.color("--surface-raised"), 0.92),
          color: disabled ? t.color("--interactive-disabled-fg") : t.color("--text-primary"),
          fontFamily: fontFace(t.number("--font-weight-regular")),
          fontSize: t.length("--typo-body-size"),
          ...(fontVariant.length ? { fontVariant } : null),
        }}
      />
      {error || description ? (
        <View accessibilityRole={error ? "alert" : undefined} accessibilityLiveRegion={error ? "polite" : undefined}>
          <BaseText
            maxFontSizeMultiplier={maxFontScale.reading}
            style={{ ...textStyle(t, "body"), color: error ? t.color("--danger") : t.color("--text-secondary") }}
          >
            {error ?? description}
          </BaseText>
        </View>
      ) : null}
    </View>
  );
}
