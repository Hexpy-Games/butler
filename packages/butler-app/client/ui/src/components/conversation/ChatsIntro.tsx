import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/app/api.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { isGeneralChat } from "@/app/isGeneralChat";
import { notifyError } from "@/app/notifications.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SettingsView } from "@/app/types.ts";
import { MessageBubble, Stack, Typo } from "@/butler-ds";

// Presentation state lasts until the app exits, including settings changes and chat switches.
const useIntroSession = create(() => ({ shown: false }));

export function useChatsIntroVisible() {
  const general = useButlerStore(state => isGeneralChat(state.activeChatId));
  const seen = useButlerStore(state => state.settings.chats_intro_seen);
  const shown = useIntroSession(state => state.shown);
  return general && (shown || seen === false);
}

export function ChatsIntro() {
  useAppLocale();
  useEffect(() => {
    const session = useIntroSession.getState();
    if (session.shown) return;
    useIntroSession.setState({ shown: true });
    void api<SettingsView>("/settings", { method: "PATCH", body: JSON.stringify({ chats_intro_seen: true }) })
      .then(settings => useButlerStore.getState().setSettings(settings))
      .catch(error => notifyError(error, appCopy.settings.errors.saveFailed, { id: "chats-intro" }));
  }, []);
  return <Stack alignSelf="stretch" gap="lg"><MessageBubble><Typo.Body data-test-class="chats-intro">{appCopy.conversation.chatsIntro}</Typo.Body></MessageBubble></Stack>;
}
