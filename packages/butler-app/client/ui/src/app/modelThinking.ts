import { create } from "zustand";
import type { TimelineEvent } from "./types";

type State = { lines: Record<string, string>; summaries: Record<string, { stream: string; text: string }> };
export const useModelThinking = create<State>(() => ({ lines: {}, summaries: {} }));
const terminal = new Set(["delivered", "failed", "cancelled", "runtime_fault"]);

function forget(turn: string) {
  useModelThinking.setState(state => {
    if (!(turn in state.lines) && !(turn in state.summaries)) return state;
    const lines = { ...state.lines };
    delete lines[turn];
    const summaries = { ...state.summaries };
    delete summaries[turn];
    return { lines, summaries };
  });
}
/** Live summaries bypass timeline reducers and all persistence. */
export function receiveModelThinking(event: TimelineEvent): boolean {
  if (event.type !== "turn.thinking") return false;
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload?.turn_id !== "string") return true;
  const turn = payload.turn_id;
  if (typeof payload.line === "string" && payload.line || typeof payload.summary === "string" && payload.summary) {
    const line = typeof payload.line === "string" ? payload.line : undefined;
    const summary = typeof payload.summary === "string" && payload.summary.trim()
      ? { stream: String(payload.stream_id ?? ""), text: payload.summary } : undefined;
    useModelThinking.setState(state => {
      const lines = { ...state.lines }, summaries = { ...state.summaries };
      if (line) lines[turn] = line; else delete lines[turn];
      if (summary) summaries[turn] = summary; else delete summaries[turn];
      return { lines, summaries };
    });
  } else forget(turn);
  return true;
}
export function reconcileModelThinking(event: TimelineEvent) {
  const payload = event.payload;
  const turn = payload?.turn;
  if (event.type === "turn.state_changed") {
    const view = (turn ?? payload) as { id?: string; turn_id?: string; state?: string };
    if (view?.state && terminal.has(view.state)) {
      const id = view.turn_id ?? view.id;
      if (id) forget(id);
    }
  }
  if (event.type === "message.created" || event.type === "message.updated") {
    const message = payload?.message;
    if (message?.role === "assistant" && message.turn_id && terminal.has(message.status ?? "")) forget(message.turn_id);
  }
  if (event.type === "session.cleared") abandonModelThinking();
}
export function abandonModelThinking() { useModelThinking.setState({ lines: {}, summaries: {} }); }
