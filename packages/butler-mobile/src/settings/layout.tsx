import { type ComponentRef, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, type NativeStackNavigationOptions } from "expo-router";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { Button, ListGroupItem, Spinner, Surface, Text, useHeaderOptions, useTokens } from "@/ds";
import { useAppLocale } from "@/i18n";

export function SettingsScreen({ title, children, options }: {
  title: string; children: React.ReactNode; options?: NativeStackNavigationOptions;
}) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const gutter = t.length("--adaptive-page-gutter");
  // KeyboardAvoidingView measures from its parent, not the window; offset by where the page starts on screen.
  const frame = useRef<ComponentRef<typeof View>>(null);
  const [top, setTop] = useState(0);
  // iOS adds the bottom safe area through contentInsetAdjustmentBehavior; Android needs it in the content.
  return <Surface variant="base" grow edges={["left", "right"]}>
    <Stack.Screen options={{ ...useHeaderOptions(), title, ...options }} />
    <View ref={frame} style={{ flex: 1 }} onLayout={() => frame.current?.measureInWindow((_x, y) => setTop(y))}>
      <KeyboardAvoidingView behavior="height" enabled={Platform.OS === "android"} keyboardVerticalOffset={top} style={{ flex: 1 }}>
        <ScrollView automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: gutter, paddingBottom: gutter + (Platform.OS === "android" ? insets.bottom : 0), gap: t.length("--space-6") }}>
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  </Surface>;
}

export function LoadState({ error, message, onRetry }: { error: boolean; message?: string; onRetry(): void }) {
  const S = getAppCopy(useAppLocale()).settings;
  return <ListGroupItem>{error ? <><Text tone="danger">{message ?? S.sectionState.error}</Text><Button variant="secondary" label={S.sectionState.retry} onPress={onRetry} /></>
    : <Spinner label={S.sectionState.loading} />}</ListGroupItem>;
}
