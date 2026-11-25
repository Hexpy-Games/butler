import { useRef, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { Stack, router } from "expo-router";
import { displayAddress } from "@/connection/route";
import { useConversation } from "@/conversation/live";
import { Button, icons, ListGroup, ListRow, Sheet, Surface, Text, useHeaderOptions, useTokens, type IconGlyph } from "@/ds";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { SETTINGS_GROUPS } from "@/settings/sections";
import { useAppLocale, useMobileCopy } from "@/i18n";

const SECTION_ICONS = {
  general: icons.SlidersHorizontal, notifications: icons.Bell, appearance: icons.Palette, personalization: icons.UserRound, memory: icons.Notebook, models: icons.AiChip,
  updates: icons.RefreshCcw, usage: icons.Database, browser: icons.Globe2, security: icons.Lock,
  archives: icons.Archive, about: icons.Document,
} satisfies Record<(typeof SETTINGS_GROUPS)[number]["ids"][number], IconGlyph>;

export default function Settings() {
  const copy = useMobileCopy();
  const S = getAppCopy(useAppLocale()).settings;
  const sections = { ...S.sections, notifications: copy.settings.notifications };
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const gutter = t.length("--adaptive-page-gutter");
  const { pairing, disconnect } = useConversation();
  const address = pairing ? displayAddress(pairing, pairing.addresses[0], copy.problems.outsideAccess) : "";
  const [open, setOpen] = useState(false);
  const leaving = useRef(false);
  const version = Application.nativeApplicationVersion === null || Application.nativeBuildVersion === null
    ? copy.settings.version(Constants.expoConfig?.version ?? "")
    : copy.settings.version(Application.nativeApplicationVersion, Application.nativeBuildVersion);
  // iOS adds the bottom safe area through contentInsetAdjustmentBehavior; Android needs it in the content.
  return <Surface variant="base" grow edges={["left", "right"]}>
    <Stack.Screen options={{ ...useHeaderOptions(), title: copy.settings.title }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: gutter, paddingBottom: gutter + (Platform.OS === "android" ? insets.bottom : 0), gap: t.length("--space-6") }}>
      {pairing ? <ListGroup label={copy.settings.computer}>
        <ListRow icon={icons.Computer} title={pairing.computerName ?? address} />
      </ListGroup> : null}
      {SETTINGS_GROUPS.map(group => <ListGroup key={group.label} label={S.groups[group.label]}>
        {group.ids.map(id => <ListRow key={id} icon={SECTION_ICONS[id]} title={sections[id]}
          navigates onPress={() => router.push(`/settings/${id}`)} />)}
      </ListGroup>)}
      <ListGroup>
        <ListRow icon={icons.Unlink} title={copy.settings.disconnect} destructive onPress={() => setOpen(true)} />
      </ListGroup>
      <View><Text variant="caption" tone="tertiary" align="center">{version}</Text></View>
    </ScrollView>
    <Sheet open={open} onClose={() => setOpen(false)} title={copy.settings.disconnectTitle}
      onClosed={() => { if (leaving.current) void disconnect(); }}
      description={copy.settings.disconnectBody} cancelLabel={copy.settings.cancel}
      action={<Button variant="destructive" label={copy.settings.disconnect} onPress={() => { leaving.current = true; setOpen(false); }} />} />
  </Surface>;
}
