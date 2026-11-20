import { useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, Stack } from "expo-router";
import type { NavigationView } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { IconButton, icons, ListRow, Sheet, useHeaderOptions, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";

export function NewConversationSheet({ view }: { view: NavigationView | null }) {
  const copy = useMobileCopy();
  const appCopy = getAppCopy(useAppLocale());
  const options = useHeaderOptions();
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const projects = view?.projects.filter(project => !project.archived) ?? [];
  const groups = view?.space.groups ?? [];
  const start = (project?: string, group?: string) => {
    setOpen(false);
    router.push({ pathname: "/chat/new", params: {
      ...(project ? { project } : {}), ...(group ? { group } : {}),
    } });
  };
  const newChat = () => {
    if (!view) return;
    if (!projects.length && !groups.length) start();
    else setOpen(true);
  };
  return <>
    <Stack.Screen options={{ ...options, title: copy.conversations.title, headerLargeTitle: Platform.OS === "ios" }} />
    {Platform.OS === "ios" ? <Stack.Toolbar placement="bottom">
      <Stack.Toolbar.Spacer />
      <Stack.Toolbar.Button icon="square.and.pencil" accessibilityLabel={appCopy.space.newChat} disabled={!view} onPress={newChat} />
    </Stack.Toolbar> : <View style={{ position: "absolute", right: t.length("--space-4"), bottom: t.length("--space-4") + insets.bottom }}>
      <IconButton icon={icons.Edit} variant="default" label={appCopy.space.newChat} disabled={!view} onPress={newChat} />
    </View>}
    <Sheet open={open} onClose={() => setOpen(false)} title={appCopy.space.newChat} cancelLabel={copy.chat.close}>
      <ListRow icon={icons.MessageSquare} title={appCopy.interfacePanels.generalChat} onPress={() => start()} />
      {projects.map(project => <ListRow key={project.id} icon={icons.Briefcase} title={project.display_name}
        onPress={() => start(project.id)} />)}
      {groups.map(group => <ListRow key={group.id} icon={icons.Folder} title={group.title}
        onPress={() => start(group.scopeProjectId ?? undefined, group.id)} />)}
    </Sheet>
  </>;
}
