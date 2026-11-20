import { useState } from "react";
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
  const { pairing, disconnect } = useConversation();
  const [open, setOpen] = useState(false);
  const version = Application.nativeApplicationVersion === null || Application.nativeBuildVersion === null
    ? copy.settings.version(Constants.expoConfig?.version ?? "")
    : copy.settings.version(Application.nativeApplicationVersion, Application.nativeBuildVersion);
  return <Surface variant="base" grow edges={["left", "right"]}>
    <Stack.Screen options={{ ...useHeaderOptions(), title: copy.settings.title }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: t.length("--space-4"), gap: t.length("--space-4") }}>
      {pairing ? <View style={{ gap: t.length("--space-2") }}>
        <Text variant="sectionTitle">{copy.settings.computer}</Text>
        <ListRow title={new URL(pairing.origin).hostname} description={pairing.origin.replace(/^[^:]+:\/\//, "")} />
      </View> : null}
      <Button variant="destructive" label={copy.settings.disconnect} onPress={() => setOpen(true)} />
      <Text variant="caption">{version}</Text>
    </ScrollView>
    <Sheet open={open} onClose={() => setOpen(false)} title={copy.settings.disconnectTitle}
      description={copy.settings.disconnectBody} cancelLabel={copy.settings.cancel}
      action={<Button variant="destructive" label={copy.settings.disconnect} onPress={() => { void disconnect(); }} />} />
  </Surface>;
}
