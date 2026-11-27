import { useCallback, useRef, useState, type ComponentRef } from "react";
import { BackHandler, Platform, Pressable, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useTokens } from "../design/useTokens";
import { IconButton } from "./Button";
import { Icon } from "./Icon";
import { Text } from "./Text";
import { icons } from "./icons";
import { GROUP_INNER_GAP } from "./internal/listGroup";
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
  const cancelHitSlop = Math.max(0, (height - t.length("--typo-body-line-height")) / 2);
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
    <View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-3") }}>
      <View style={{
        flex: 1, flexDirection: "row", alignItems: "center", height, borderRadius: height / 2,
        backgroundColor: t.color("--surface-raised"), borderWidth: t.length("--border-hairline"), borderColor: t.color("--line"),
      }}>
        <View style={{ paddingLeft: t.length("--space-5"), alignSelf: "stretch", justifyContent: "center" }}>
          {Platform.OS === "android" && active ? (
            <Pressable accessibilityRole="button" accessibilityLabel={cancelLabel} onPress={cancel}
              hitSlop={(height - t.length("--icon-size-lg")) / 2}>
              <Icon glyph={icons.ArrowLeft} size="lg" tone="secondary" />
            </Pressable>
          ) : <Icon glyph={icons.Search} size="lg" tone="tertiary" />}
        </View>
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
          style={{ flex: 1, height, paddingLeft: GROUP_INNER_GAP, paddingRight: value === "" ? t.length("--space-5") : 0, paddingVertical: 0,
            color: t.color("--text-primary"), fontFamily: fontFace(t.number("--font-weight-regular")), fontSize: t.length("--typo-body-size") }}
        />
        {value !== "" ? (
          <View style={{ marginRight: t.length("--space-2") }}>
            <IconButton icon={icons.X} size="sm" variant="ghost" label={clearLabel} onPress={() => {
              onChangeText("");
              input.current?.focus();
            }} />
          </View>
        ) : null}
      </View>
      {Platform.OS === "ios" && active ? (
        <Pressable accessibilityRole="button" accessibilityLabel={cancelLabel} onPress={cancel}
          hitSlop={{ top: cancelHitSlop, bottom: cancelHitSlop }} style={{ alignSelf: "center" }}>
          <Text tone="primary">{cancelLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
