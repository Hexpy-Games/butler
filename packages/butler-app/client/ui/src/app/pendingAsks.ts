import { api } from "./api.ts";
import type { TimelineEvent } from "./types.ts";
import type { SessionPendingAsks } from "../../../shared/pending-asks-contracts.ts";
export type { PendingAsk, SessionPendingAsks } from "../../../shared/pending-asks-contracts.ts";

type Reader = { page: SessionPendingAsks | null; listeners: Set<() => void>; controller?: AbortController; revision: number; queued: boolean; seen: Map<string, string> };
const readers = new Map<string, Reader>();

export function getSessionPendingAsks(sessionId: string, signal: AbortSignal) {
  return api<SessionPendingAsks>(`/sessions/${encodeURIComponent(sessionId)}/pending-asks`, { signal });
}
export const pendingAsksSnapshot = (sessionId: string) => readers.get(sessionId)?.page ?? null;

/** Header and margin share one demand-driven reader and the App's existing event stream. */
export function observePendingAsks(sessionId: string, listener: () => void): () => void {
  let reader = readers.get(sessionId);
  if (!reader) {
    reader = { page: null, listeners: new Set(), revision: 0, queued: false, seen: new Map() };
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
    reader.seen.clear();
    const revision = ++reader.revision;
    void getSessionPendingAsks(sessionId, controller.signal).then(page => {
      if (!controller.signal.aborted && reader.revision === revision && page.session_id === sessionId) {
        reader.page = page;
        for (const listener of reader.listeners) listener();
      }
    }).catch(() => { /* An unavailable projection never fabricates a section or a dot. */ }).finally(() => {
      if (reader.controller !== controller) return;
      reader.controller = undefined;
      if (reader.page?.asks.some(ask => {
        const id = reader.seen.get(`${ask.source_session_id}\u0000${ask.source_turn_id}`);
        return id !== undefined && ask.source_message_id !== id;
      })) refresh(sessionId, reader);
    });
  });
}
export function publishPendingAsksEvent(event: TimelineEvent) {
  if (event.type === "stream.reconcile_required") {
    for (const [sessionId, reader] of readers) refresh(sessionId, reader);
  } else if (event.type === "message.created" || event.type === "message.updated") {
    const message = event.payload?.message;
    if (message?.role !== "assistant" || typeof message.chat_id !== "string"
      || typeof message.turn_id !== "string" || typeof message.id !== "string") return;
    // Aborting reads on streaming updates would starve them. Record seen replies instead,
    // including delegated sources, so a completed page is re-read only if its source is stale.
    for (const [sessionId, reader] of readers) {
      if (reader.controller) reader.seen.set(`${message.chat_id}\u0000${message.turn_id}`, message.id);
      else if (reader.page?.asks.some(ask => ask.source_session_id === message.chat_id
        && ask.source_turn_id === message.turn_id && ask.source_message_id !== message.id)) refresh(sessionId, reader);
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
