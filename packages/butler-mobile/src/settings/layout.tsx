import { ScrollView, View } from "react-native";
import { Stack } from "expo-router";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { Button, Spinner, Surface, Text, useHeaderOptions, useTokens } from "@/ds";
import { useAppLocale } from "@/i18n";

export function SettingsScreen({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  const t = useTokens();
  const gutter = t.length("--adaptive-page-gutter");
  return <Surface variant="base" grow edges={["left", "right"]}>
    <Stack.Screen options={{ ...useHeaderOptions(), title }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingVertical: gutter, gap: t.length("--space-4") }}>
      {description ? <View style={{ paddingHorizontal: gutter }}><Text tone="secondary">{description}</Text></View> : null}
      {children}
    </ScrollView>
  </Surface>;
}

export function SettingsGroup({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  const t = useTokens();
  return <View style={{ gap: t.length("--space-2") }}>
    <View style={{ paddingHorizontal: t.length("--adaptive-page-gutter"), gap: t.length("--space-2") }}>
      <Text variant="sectionTitle">{title}</Text>
      {description ? <Text variant="caption" tone="secondary">{description}</Text> : null}
    </View>
    <View style={{ paddingHorizontal: t.length("--space-sm"), gap: t.length("--space-2") }}>{children}</View>
  </View>;
}

export function GroupInset({ children }: { children: React.ReactNode }) {
  const t = useTokens();
  return <View style={{ paddingHorizontal: t.length("--space-sm"), gap: t.length("--space-2") }}>{children}</View>;
}

export function LoadState({ error, message, onRetry }: { error: boolean; message?: string; onRetry(): void }) {
  const S = getAppCopy(useAppLocale()).settings;
  return error ? <><Text tone="danger">{message ?? S.sectionState.error}</Text><Button variant="secondary" label={S.sectionState.retry} onPress={onRetry} /></>
    : <Spinner label={S.sectionState.loading} />;
}
