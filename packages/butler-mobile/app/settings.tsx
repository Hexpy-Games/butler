import { useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { Stack } from "expo-router";
import { useConversation } from "@/conversation/live";
import { Button, ListRow, Sheet, Surface, Text, useHeaderOptions, useTokens } from "@/ds";
import { useMobileCopy } from "@/i18n";

export default function Settings() {
  const copy = useMobileCopy();
  const t = useTokens();
  const gutter = t.length("--adaptive-page-gutter");
  const { pairing, disconnect } = useConversation();
  const address = pairing ? pairing.origin.replace(/^[^:]+:\/\//, "") : "";
  const [open, setOpen] = useState(false);
  const leaving = useRef(false);
  const version = Application.nativeApplicationVersion === null || Application.nativeBuildVersion === null
    ? copy.settings.version(Constants.expoConfig?.version ?? "")
    : copy.settings.version(Application.nativeApplicationVersion, Application.nativeBuildVersion);
  return <Surface variant="base" grow edges={["left", "right"]}>
    <Stack.Screen options={{ ...useHeaderOptions(), title: copy.settings.title }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingVertical: gutter, gap: t.length("--space-4") }}>
      {pairing ? <View style={{ gap: t.length("--space-2") }}>
        <View style={{ paddingHorizontal: gutter }}><Text variant="sectionTitle">{copy.settings.computer}</Text></View>
        <View style={{ paddingHorizontal: t.length("--space-sm") }}><ListRow title={pairing.computerName ?? address} description={pairing.computerName ? address : undefined} /></View>
      </View> : null}
      <View style={{ paddingHorizontal: gutter }}><Button variant="destructive" label={copy.settings.disconnect} onPress={() => setOpen(true)} /></View>
      <View style={{ paddingHorizontal: gutter }}><Text variant="caption">{version}</Text></View>
    </ScrollView>
    <Sheet open={open} onClose={() => setOpen(false)} title={copy.settings.disconnectTitle}
      onClosed={() => { if (leaving.current) void disconnect(); }}
      description={copy.settings.disconnectBody} cancelLabel={copy.settings.cancel}
      action={<Button variant="destructive" label={copy.settings.disconnect} onPress={() => { leaving.current = true; setOpen(false); }} />} />
  </Surface>;
}
