import { useEffect, useRef } from "react";
import { useButlerStore } from "@/app/store.ts";
import { appCopy } from "@/app/copy.ts";
import { showDesktopNotification } from "@/app/nativeNotifications.ts";
import { notifyStatus, dismissNotification } from "@/app/notifications.ts";

/** Canonical navigation owns waiting status, so background and delegated work
 * use the same existing desktop notification path as foreground work. */
export function useSessionAttentionNotifications(): void {
  const navigation = useButlerStore(state => state.navigation);
  const waiting = useRef(new Set<string>());
  useEffect(() => {
    const sessions = [...navigation.chats, ...navigation.projects.flatMap(project => project.sessions ?? [])];
    const next = new Set<string>();
    for (const session of sessions) {
      if (!session.attention_required && session.active_turn_state !== "waiting_for_form") continue;
      next.add(session.id);
      if (waiting.current.has(session.id)) continue;
      const body = `${session.title} · ${appCopy.space.attention}`;
      notifyStatus(body, { id: `attention:${session.id}`, duration: Infinity });
      if (useButlerStore.getState().settings.desktop_notifications.enabled) {
        void showDesktopNotification({ kind: "task_completion", title: appCopy.firstRun.product,
          body, sessionId: session.id });
      }
    }
    for (const id of waiting.current) if (!next.has(id)) dismissNotification(`attention:${id}`);
    waiting.current = next;
  }, [navigation]);
}
