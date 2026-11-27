import { useCallback, useRef, useState, type ComponentRef } from "react";
import { BackHandler, Platform, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useTokens } from "../design/useTokens";
import { Button, IconButton } from "./Button";
import { Icon } from "./Icon";
import { icons } from "./icons";
import { fontFace, maxFontScale } from "./internal/typography";

export interface SearchFieldProps {
  value: string;
  onChangeText(text: string): void;
  placeholder: string;
  clearLabel: string;
  cancelLabel: string;
  onCancel(): void;
  onSubmit?(): void;
  testID?: string;
}

export function SearchField({ value, onChangeText, placeholder, clearLabel, cancelLabel, onCancel, onSubmit, testID }: SearchFieldProps) {
  const t = useTokens();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [focused, setFocused] = useState(false);
  const active = focused || value !== "";
  const height = t.length("--control-hit-target");
  const cancel = useCallback(() => {
    onCancel();
    input.current?.blur();
  }, [onCancel]);
  useFocusEffect(useCallback(() => {
    if (Platform.OS !== "android" || !active) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      cancel();
      return true;
    });
    return () => subscription.remove();
  }, [active, cancel]));

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-2") }}>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", height, borderRadius: height / 2, backgroundColor: t.color("--surface-raised") }}>
        {Platform.OS === "android" && active
          ? <IconButton icon={icons.ArrowLeft} label={cancelLabel} onPress={cancel} />
          : <View style={{ paddingLeft: t.length("--space-sm") }}><Icon glyph={icons.Search} size="md" tone="tertiary" /></View>}
        <TextInput
          ref={input}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={t.color("--placeholder")}
          accessibilityLabel={placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          submitBehavior="blurAndSubmit"
          onSubmitEditing={onSubmit}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          maxFontSizeMultiplier={maxFontScale.control}
          testID={testID}
          style={{ flex: 1, height, paddingHorizontal: t.length("--space-sm"), paddingVertical: 0,
            color: t.color("--text-primary"), fontFamily: fontFace(t.number("--font-weight-regular")), fontSize: t.length("--typo-body-size") }}
        />
        {value !== "" ? <IconButton icon={icons.X} size="sm" variant="ghost" label={clearLabel} onPress={() => {
          onChangeText("");
          input.current?.focus();
        }} /> : null}
      </View>
      {Platform.OS === "ios" && active ? <Button variant="ghost" size="sm" label={cancelLabel} onPress={cancel} /> : null}
    </View>
  );
}
