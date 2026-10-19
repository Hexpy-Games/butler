import { create } from "zustand";
import type { TimelineEvent } from "./types";

type Summary = { round: string; title: string; text: string };
type State = { lines: Record<string, string>; summaries: Record<string, Summary[]> };
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
    const text = typeof payload.summary === "string" ? payload.summary : "";
    const round = typeof payload.round_id === "string" ? payload.round_id : "";
    useModelThinking.setState(state => {
      const lines = { ...state.lines }, summaries = { ...state.summaries };
      if (line) lines[turn] = line; else delete lines[turn];
      if (text.trim() && round) {
        const previous = summaries[turn] ?? [];
        const summary = { round, title: line ?? "", text };
        const index = previous.findIndex(item => item.round === round);
        summaries[turn] = index < 0 ? [...previous, summary] : previous.map((item, i) => i === index ? summary : item);
      }
      return { lines, summaries };
    });
  } else {
    // A provider closes before its durable Completed event. Keep the row and body.
    useModelThinking.setState(state => {
      const lines = { ...state.lines }; delete lines[turn]; return { lines };
    });
  }
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
