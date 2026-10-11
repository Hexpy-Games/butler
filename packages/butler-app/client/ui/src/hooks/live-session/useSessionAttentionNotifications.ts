import { useEffect, useRef } from "react";
import { useButlerStore } from "@/app/store.ts";
import { appCopy } from "@/app/copy.ts";
import { showDesktopNotification } from "@/app/nativeNotifications.ts";
import { notifyStatus, dismissNotification } from "@/app/notifications.ts";
import { api } from "@/app/api.ts";

/** A browser hand-off says what it waits for (§9.3); anything else stays "확인 필요". */
async function attentionLabel(sessionId: string): Promise<string> {
  const view = await api<{ requests?: unknown }>(`/authority-requests?session_id=${encodeURIComponent(sessionId)}`).catch(() => undefined);
  const requests = Array.isArray(view?.requests) ? view.requests as Array<{ approval?: { operation?: { tool?: unknown } } }> : [];
  const tool = requests[0]?.approval?.operation?.tool;
  return tool === "browser_sign_in_wait" ? appCopy.space.signInAttention
    : tool === "browser_wait_for_user" ? appCopy.space.tabAttention : appCopy.space.attention;
}

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
      void attentionLabel(session.id).then((label) => {
        if (!waiting.current.has(session.id)) return;
        const body = `${session.title} · ${label}`;
        notifyStatus(body, { id: `attention:${session.id}`, duration: Infinity });
        if (useButlerStore.getState().settings.desktop_notifications.enabled) {
          void showDesktopNotification({ kind: "task_completion", title: appCopy.firstRun.product,
            body, sessionId: session.id });
        }
      });
    }
    for (const id of waiting.current) if (!next.has(id)) dismissNotification(`attention:${id}`);
    waiting.current = next;
  }, [navigation]);
}
