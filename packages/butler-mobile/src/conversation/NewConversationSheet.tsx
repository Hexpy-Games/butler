import { useState } from "react";
import { Platform } from "react-native";
import { router, Stack } from "expo-router";
import type { NavigationView } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { IconButton, icons, ListRow, Sheet, useHeaderOptions } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";

export function NewConversationSheet({ view }: { view: NavigationView | null }) {
  const copy = useMobileCopy();
  const appCopy = getAppCopy(useAppLocale());
  const options = useHeaderOptions();
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
    <Stack.Screen options={{ ...options, title: copy.conversations.title, headerLargeTitle: Platform.OS === "ios",
      ...(Platform.OS === "ios" ? {
        unstable_headerRightItems: () => [{ type: "button", label: appCopy.space.newChat, disabled: !view,
          icon: { type: "sfSymbol", name: "square.and.pencil" }, onPress: newChat }],
      } : { headerRight: () => <IconButton icon={icons.Edit} variant="ghost" label={appCopy.space.newChat} disabled={!view} onPress={newChat} /> }) }} />
    <Sheet open={open} onClose={() => setOpen(false)} title={appCopy.space.newChat} cancelLabel={copy.chat.close}>
      <ListRow icon={icons.MessageSquare} title={appCopy.interfacePanels.generalChat} onPress={() => start()} />
      {projects.map(project => <ListRow key={project.id} icon={icons.Briefcase} title={project.display_name}
        onPress={() => start(project.id)} />)}
      {groups.map(group => <ListRow key={group.id} icon={icons.Folder} title={group.title}
        onPress={() => start(group.scopeProjectId ?? undefined, group.id)} />)}
    </Sheet>
  </>;
}
