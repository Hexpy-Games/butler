import { useEffect } from "react";
import {
  setNativeShellPreferences,
  subscribeNativeNavigation,
} from "@/app/nativeNotifications.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SettingsView } from "@/app/types.ts";

export function useNativeShellPreferences(settings: SettingsView): void {
  const openNewChat = useButlerStore((state) => state.openNewChat);
  const openSession = useButlerStore((state) => state.openSession);

  useEffect(() => {
    void setNativeShellPreferences(settings);
  }, [settings.desktop_tray_enabled]);

  useEffect(() => {
    return subscribeNativeNavigation((request) => {
      if (request.action === "new-chat") {
        openNewChat();
        return;
      }
      if (request.action === "open-session") {
        openSession(request.sessionId);
      }
    });
  }, [openNewChat, openSession]);
}
