import { api } from "./api.ts";
import type { TimelineEvent } from "./types.ts";
import type { SessionPendingAsks } from "../../../shared/pending-asks-contracts.ts";
export type { PendingAsk, SessionPendingAsks } from "../../../shared/pending-asks-contracts.ts";

type Reader = { page: SessionPendingAsks | null; listeners: Set<() => void>; controller?: AbortController; revision: number; queued: boolean; loading: boolean };
const readers = new Map<string, Reader>();

export function getSessionPendingAsks(sessionId: string, signal: AbortSignal) {
  return api<SessionPendingAsks>(`/sessions/${encodeURIComponent(sessionId)}/pending-asks`, { signal });
}
export const pendingAsksSnapshot = (sessionId: string) => readers.get(sessionId)?.page ?? null;

/** Header and margin share one demand-driven reader and the App's existing event stream. */
export function observePendingAsks(sessionId: string, listener: () => void): () => void {
  let reader = readers.get(sessionId);
  if (!reader) {
    reader = { page: null, listeners: new Set(), revision: 0, queued: false, loading: false };
    readers.set(sessionId, reader);
    refresh(sessionId, reader);
  }
  reader.listeners.add(listener);
  return () => {
    reader.listeners.delete(listener);
    if (!reader.listeners.size) { reader.controller?.abort(); readers.delete(sessionId); }
  };
}
function refresh(sessionId: string, reader: Reader) {
  if (reader.queued) return;
  reader.queued = true;
  queueMicrotask(() => {
    reader.queued = false;
    if (readers.get(sessionId) !== reader) return;
    reader.controller?.abort();
    const controller = new AbortController();
    reader.controller = controller;
    const revision = ++reader.revision;
    reader.loading = true;
    void getSessionPendingAsks(sessionId, controller.signal).then(page => {
      if (!controller.signal.aborted && reader.revision === revision && page.session_id === sessionId) {
        reader.page = page;
        for (const listener of reader.listeners) listener();
      }
    }).catch(() => { /* An unavailable projection never fabricates a section or a dot. */ }).finally(() => {
      if (reader.revision === revision) reader.loading = false;
    });
  });
}
export function publishPendingAsksEvent(event: TimelineEvent) {
  if (event.type === "stream.reconcile_required") {
    for (const [sessionId, reader] of readers) refresh(sessionId, reader);
  } else if (event.type === "message.created") {
    // The gateway resolves an ask's source to the turn's latest assistant message, and falls back to
    // the user message until one is saved. Saving a reply moves that source, so read it again.
    const message = event.payload?.message as { id?: string; chat_id?: string; role?: string; turn_id?: string } | undefined;
    const reader = message?.role === "assistant" && message.turn_id && message.chat_id ? readers.get(message.chat_id) : undefined;
    if (reader && (reader.loading || reader.page?.asks.some(ask => ask.source_turn_id === message!.turn_id && ask.source_message_id !== message!.id))) {
      refresh(message!.chat_id!, reader);
    }
  } else if (event.type === "pending_asks.changed" && typeof event.payload?.session_id === "string") {
    const reader = readers.get(event.payload.session_id);
    if (!reader) return;
    const sessionId = event.payload.session_id;
    const { open_count: openCount, ask_id: askId, state } = event.payload as Record<string, unknown>;
    if (typeof openCount === "number" && Number.isInteger(openCount) && openCount >= 0) {
      reader.controller?.abort();
      reader.revision++;
      reader.page = {
        session_id: sessionId,
        open_count: openCount,
        asks: openCount === 0 ? [] : (reader.page?.asks ?? []).filter(ask => ask.ask_id !== askId || state === "open"),
      };
      for (const listener of reader.listeners) listener();
    }
    refresh(sessionId, reader);
  }
}
