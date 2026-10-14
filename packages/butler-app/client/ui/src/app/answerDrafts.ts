import { create } from "zustand";
import type { AnswerBlockView } from "../../../shared/answer-blocks-view";

import type { TimelineEvent, MessageRecord } from "./types";

type Unit = Record<string, unknown>;
export type AnswerDraft = {
  sessionId: string; turnId: string; call: string; seq: number;
  incoming: Record<string, unknown[]>; raw: Unit[]; blocks: (AnswerBlockView | null)[]; open: boolean[];
  lastBlock: number; outcome: string; present: boolean;
};
type State = { answerDrafts: Record<string, AnswerDraft>; sessions: Record<string, string[]> };
export const useAnswerDrafts = create<State>(() => ({ answerDrafts: {}, sessions: {} }));
const emptyTurns: string[] = [];
export const draftTurns = (state: State, session: string) => state.sessions[session] ?? emptyTurns;

function operation(draft: AnswerDraft, op: Unit): AnswerDraft {
  if (op.op === "end") {
    const accepted = op.outcome === "accepted";
    return { ...draft, outcome: String(op.outcome),
      raw: accepted ? draft.raw.slice(0, draft.lastBlock + 1) : draft.raw,
      blocks: accepted ? draft.blocks.slice(0, draft.lastBlock + 1) : draft.blocks,
      present: !(op.outcome === "delivered" && draft.outcome !== "accepted") && !["failed", "cancelled", "runtime_fault"].includes(String(op.outcome)) };
  }
  const seq = Number(op.seq), bi = Number(op.bi);
  if (!Number.isInteger(seq) || seq <= draft.seq || !Number.isInteger(bi) || bi < 0 || bi >= 8) return draft;
  const raw = [...draft.raw], blocks = [...draft.blocks], open = [...draft.open];
  const incoming = { ...draft.incoming };
  let block = { ...raw[bi] };
  if (op.op === "block") {
    const value = op.value as Unit;
    block = block.type === value.type ? { ...block, ...value } : value;
    open[bi] = true;
  }
  if (op.op === "field") block = { ...block, [String(op.field)]: op.value };
  if (op.op === "item") {
    const list = String(op.list);
    const items = [...(Array.isArray(block[list]) ? block[list] as unknown[] : [])];
    const next = [...(incoming[`${bi}:${list}`] ?? []), op.value];
    incoming[`${bi}:${list}`] = next;
    const key = (op.value as Unit)?.key;
    const position = key === undefined ? Number(op.index) : items.findIndex(item => (item as Unit)?.key === key);
    if (position >= 0 && position < items.length) items[position] = op.value;
    else items.push(op.value);
    block = { ...block, [list]: items };
  }
  if (op.op === "list_end") {
    block = { ...block, [String(op.list)]: incoming[`${bi}:${op.list}`] ?? [] };
    open[bi] = false;
  }
  if (op.op === "block_end") open[bi] = false;
  raw[bi] = block;
  // Ops were normalized and validated by the agent; do not reparse the prefix.
  const ready = Array.isArray(block.items) ? block.items.length > 0
    : block.type === "table" ? Array.isArray(block.columns) && block.columns.length > 0
    : block.type === "chart" ? Array.isArray(block.x) && Array.isArray(block.series) && typeof block.source === "string" && typeof block.checked === "string"
    : block.type === "callout" && typeof block.text === "string";
  if (block.type === "table" && !Array.isArray(block.rows)) block = { ...block, rows: [] };
  blocks[bi] = ready ? block as unknown as AnswerBlockView : null;
  return { ...draft, seq, raw, blocks, open, incoming, lastBlock: Math.max(draft.lastBlock, bi) };
}

function apply(payload: Unit, previous?: AnswerDraft): AnswerDraft | undefined {
  if (typeof payload.turn_id !== "string" || typeof payload.session_id !== "string" || !Array.isArray(payload.ops)) return previous;
  if (!previous && payload.ops.every(op => (op as Unit).op === "end")) return undefined;
  const call = payload.stream_id ? `${payload.stream_id}:${payload.call_index}` : previous?.call ?? "";
  let draft: AnswerDraft = previous ?? { sessionId: payload.session_id, turnId: payload.turn_id,
    call, seq: 0, incoming: {}, raw: [], blocks: [], open: [], lastBlock: -1, outcome: "streaming", present: true };
  if (call !== draft.call) draft = { ...draft, call, seq: 0, incoming: {}, open: [], lastBlock: -1, outcome: "streaming", present: true };
  for (const op of payload.ops) draft = operation(draft, op as Unit);
  return draft;
}

let pending: TimelineEvent[] = [];
let frame: number | undefined;
/** Transport frames never enter the message reducer; all units flush once per paint. */
export function receiveAnswerDraft(event: TimelineEvent): boolean {
  if (!event.type.startsWith("answer_blocks.")) return false;
  pending.push(event);
  frame ??= requestAnimationFrame(flush);
  return true;
}
function flush() {
  frame = undefined;
  const events = pending; pending = [];
  useAnswerDrafts.setState(state => {
    let drafts = { ...state.answerDrafts };
    for (const event of events) {
      if (event.type === "answer_blocks.snapshot") {
        drafts = {};
        for (const payload of ((event.payload as Unit)?.drafts ?? []) as Unit[]) {
          const draft = apply(payload); if (draft) drafts[draft.turnId] = draft;
        }
      } else {
        const payload = event.payload as Unit;
        const turn = String(payload.turn_id);
        const draft = apply(payload, drafts[turn]); if (draft) drafts[turn] = draft;
      }
    }
    const sessions: State["sessions"] = {};
    for (const draft of Object.values(drafts)) (sessions[draft.sessionId] ??= []).push(draft.turnId);
    for (const [id, turns] of Object.entries(sessions)) {
      if (JSON.stringify(turns) === JSON.stringify(state.sessions[id])) sessions[id] = state.sessions[id];
    }
    return { answerDrafts: drafts, sessions };
  });
}
export function abandonAnswerDrafts() {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined; pending = [];
  useAnswerDrafts.setState(state => ({ answerDrafts: Object.fromEntries(Object.entries(state.answerDrafts)
    .map(([id, draft]) => [id, { ...draft, present: false }])) }));
}
export function forgetAnswerDraft(turn: string) {
  useAnswerDrafts.setState(state => {
    const draft = state.answerDrafts[turn]; if (!draft) return state;
    const answerDrafts = { ...state.answerDrafts }; delete answerDrafts[turn];
    return { answerDrafts, sessions: { ...state.sessions, [draft.sessionId]: (state.sessions[draft.sessionId] ?? []).filter(id => id !== turn) } };
  });
}
/** A display projection only: no synthetic message is inserted into the canonical store. */
export function withDraftMessages(messages: MessageRecord[], turns: string[], session: string): MessageRecord[] {
  const missing = turns.filter(turn => !messages.some(message => message.role === "assistant" && message.turn_id === turn));
  return missing.length ? [...messages, ...missing.map(turn => ({ id: `draft-${turn}`, role: "assistant" as const,
    turn_id: turn, chat_id: session, status: "streaming", text: "" }))] : messages;
}
