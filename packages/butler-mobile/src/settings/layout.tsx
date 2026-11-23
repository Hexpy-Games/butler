import { type ComponentRef, useEffect, useRef, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, type NativeStackNavigationOptions } from "expo-router";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { Button, ListGroupItem, Spinner, Surface, Text, useHeaderOptions, useTokens } from "@/ds";
import { useAppLocale } from "@/i18n";

export function SettingsScreen({ title, children, options, onEndReached }: {
  title: string; children: React.ReactNode; options?: NativeStackNavigationOptions; onEndReached?: () => void;
}) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const gutter = t.length("--adaptive-page-gutter");
  // KeyboardAvoidingView measures from its parent, not the window; offset by where the page starts on screen.
  const frame = useRef<ComponentRef<typeof View>>(null);
  const [top, setTop] = useState(0);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const offset = useRef(0);
  const viewportHeight = useRef(0), contentHeight = useRef(0);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const show = Keyboard.addListener("keyboardDidShow", (event) => {
      // Wait for the shrink above the keyboard, then move the focused field above it.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        TextInput.State.currentlyFocusedInput()?.measureInWindow((_x, y, _width, height) => {
          const over = y + height + gutter - event.endCoordinates.screenY;
          if (over > 0) scroll.current?.scrollTo({ y: offset.current + over, animated: true });
        });
      }));
    });
    return () => show.remove();
  }, [gutter]);

  // iOS adds the bottom safe area through contentInsetAdjustmentBehavior; Android needs it in the content.
  return <Surface variant="base" grow edges={["left", "right"]}>
    <Stack.Screen options={{ ...useHeaderOptions(), title, ...options }} />
    <View ref={frame} style={{ flex: 1 }} onLayout={() => frame.current?.measureInWindow((_x, y) => setTop(y))}>
      <KeyboardAvoidingView behavior="height" enabled={Platform.OS === "android"} keyboardVerticalOffset={top} style={{ flex: 1 }}>
        <ScrollView ref={scroll} scrollEventThrottle={16} onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
          offset.current = contentOffset.y;
          if (layoutMeasurement.height + contentOffset.y >= contentSize.height - layoutMeasurement.height) onEndReached?.();
        }} onLayout={onEndReached ? ({ nativeEvent }) => {
          viewportHeight.current = nativeEvent.layout.height;
          if (contentHeight.current < viewportHeight.current) onEndReached();
        } : undefined} onContentSizeChange={onEndReached ? (_width, height) => {
          contentHeight.current = height;
          if (height < viewportHeight.current) onEndReached();
        } : undefined} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: gutter, paddingBottom: gutter + (Platform.OS === "android" ? insets.bottom : 0), gap: t.length("--space-6") }}>
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
