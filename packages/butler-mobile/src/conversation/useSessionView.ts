import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import type { ConversationMessage, SessionView } from "../../../butler-protocol/src/index.ts";
import type { GatewayClient } from "../../../butler-protocol/src/client/index.ts";
import { useConversation } from "./live";
import { applyLiveEvent, mergeMessages } from "./sessionView";

/** Messages per /session-view page; the conversation renders one page in its first pass. */
export const SESSION_PAGE = 50;

export function useSessionView(id: string | undefined) {
  const { client, reconcile, subscribe } = useConversation();
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const requestRef = useRef<(older?: boolean) => void>(() => {});
  useEffect(() => {
    setView(null); setError(false); setLoadingEarlier(false);
    if (!client || !id) return;
    let current: SessionView | null = null;
    let closed = false, busy = false, pending = false, last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = (next: SessionView) => { current = next; setView(next); };
    const request = (older = false) => {
      if (closed) return;
      const token = older && current?.message_window.has_more ? current.message_window.previous_cursor_token : undefined;
      if (older && (!token || busy)) return;
      if (!older) pending = true;
      if (busy || (!older && timer)) return;
      const delay = last + 1000 - Date.now();
      if (!older && delay > 0) {
        timer = setTimeout(() => { timer = undefined; request(); }, delay);
        return;
      }
      busy = true;
      if (!older) { pending = false; last = Date.now(); }
      setLoadingEarlier(older);
      const before = token ? `&before_cursor_token=${encodeURIComponent(token)}` : "";
      void client.request<SessionView>(`/session-view?session_id=${encodeURIComponent(id)}${before}&limit=${SESSION_PAGE}`).then(next => {
        if (closed) return;
        publish(mergeSessionView(current, next, older));
        setError(false);
      }).catch(() => { if (!closed && !current) setError(true); }).finally(() => {
        busy = false;
        if (!closed) setLoadingEarlier(false);
        if (pending) request();
      });
    };
    requestRef.current = request;
    const unsubscribe = subscribe(event => {
      if (!current) { request(); return; }
      const next = applyLiveEvent(current, event);
      if (next === "refetch") request();
      else if (next) publish(next);
    });
    request();
    return () => {
      closed = true; clearTimeout(timer); unsubscribe();
      requestRef.current = () => {};
    };
  }, [client, id, subscribe]);
  const seen = useRef(reconcile);
  useEffect(() => {
    if (seen.current === reconcile) return;
    seen.current = reconcile;
    requestRef.current();
  }, [reconcile]);
  useSessionRead(client, id, view?.latest_turn ? `${view.latest_turn.id}:${view.latest_turn.state}` : undefined);
  const reload = useCallback(() => requestRef.current(), []);
  const loadEarlier = useCallback(() => requestRef.current(true), []);
  return { view, error, loadingEarlier, reload, loadEarlier };
}

function mergeSessionView(previous: SessionView | null, next: SessionView, older: boolean): SessionView {
  if (!previous) return next;
  const answers = new Map([...(previous.question_answers ?? []), ...(next.question_answers ?? [])].map(answer => [answer.request_ref, answer]));
  if (older) return {
    ...previous, messages: mergeMessages(previous.messages, next.messages),
    question_answers: [...answers.values()],
    message_window: { ...previous.message_window, previous_cursor_token: next.message_window.previous_cursor_token, has_more: next.message_window.has_more },
  };
  const first = next.messages[0], last = next.messages.at(-1);
  const ids = new Set(next.messages.map(message => message.id));
  const retained = previous.messages.filter(message => ids.has(message.id)
    || !first || !last || before(message, first) || before(last, message));
  return {
    ...next, messages: mergeMessages(retained, next.messages),
    question_answers: [...answers.values()],
    message_window: retained.length ? {
      ...next.message_window, previous_cursor_token: previous.message_window.previous_cursor_token, has_more: previous.message_window.has_more,
    } : next.message_window,
  };
}

/** True when `a` sorts before `b` (cursor when both have one, else creation time). */
function before(a: ConversationMessage, b: ConversationMessage): boolean {
  return a.cursor !== undefined && b.cursor !== undefined ? a.cursor < b.cursor
    : !!a.created_at && !!b.created_at && a.created_at < b.created_at;
}

function useSessionRead(client: GatewayClient | null, id: string | undefined, turn: string | undefined) {
  const focused = useRef(false);
  const read = useCallback((leaving = false) => {
    if (id && (focused.current || leaving) && AppState.currentState === "active") {
      void client?.request(`/sessions/${encodeURIComponent(id)}/read`, { body: {} }).catch(() => {});
    }
  }, [client, id]);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    read();
    const subscription = AppState.addEventListener("change", value => { if (value === "active") read(); });
    return () => { focused.current = false; subscription.remove(); read(true); };
  }, [read]));
  useEffect(() => {
    if (turn && ["delivered", "failed", "cancelled", "runtime_fault"].includes(turn.split(":").at(-1) ?? "")) read();
  }, [read, turn]);
}
