import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { Button, ListGroupItem, Spinner, Surface, Text, useHeaderOptions, useTokens } from "@/ds";
import { useAppLocale } from "@/i18n";

export function SettingsScreen({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const gutter = t.length("--adaptive-page-gutter");
  // iOS adds the bottom safe area through contentInsetAdjustmentBehavior; Android needs it in the content.
  return <Surface variant="base" grow edges={["left", "right"]}>
    <Stack.Screen options={{ ...useHeaderOptions(), title }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: gutter, paddingBottom: gutter + (Platform.OS === "android" ? insets.bottom : 0), gap: t.length("--space-6") }}>
      {description ? <View style={{ paddingHorizontal: t.length("--space-4") }}><Text tone="secondary">{description}</Text></View> : null}
      {children}
    </ScrollView>
  </Surface>;
}

export function LoadState({ error, message, onRetry }: { error: boolean; message?: string; onRetry(): void }) {
  const S = getAppCopy(useAppLocale()).settings;
  return <ListGroupItem>{error ? <><Text tone="danger">{message ?? S.sectionState.error}</Text><Button variant="secondary" label={S.sectionState.retry} onPress={onRetry} /></>
    : <Spinner label={S.sectionState.loading} />}</ListGroupItem>;
}
