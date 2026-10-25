import { create } from "zustand";
import type { AnswerBlockView } from "../../../shared/answer-blocks-view";

import type { TimelineEvent, MessageRecord } from "./types";

type Unit = Record<string, unknown>;
type Outcome = "streaming" | "accepted" | "rejected";
/** One answer_blocks call's validated units, positioned by the call's own block index. */
export type AnswerDraftCall = {
  id: string; stream: string; callId?: string; seq: number; outcome: Outcome;
  incoming: Record<string, unknown[]>; raw: Unit[]; blocks: (AnswerBlockView | null)[]; open: boolean[]; lastBlock: number;
};
/** A turn's calls in arrival order; `early` holds outcomes that arrived before their call's first unit. */
export type AnswerDraft = { sessionId: string; turnId: string; calls: AnswerDraftCall[]; early: Record<string, Outcome>; present: boolean };
export type AnswerDraftBlock = { raw: Unit; view: AnswerBlockView | null; open: boolean; incoming?: unknown[] };
type State = { answerDrafts: Record<string, AnswerDraft>; sessions: Record<string, string[]> };
export const useAnswerDrafts = create<State>(() => ({ answerDrafts: {}, sessions: {} }));
const emptyTurns: string[] = [];
export const draftTurns = (state: State, session: string) => state.sessions[session] ?? emptyTurns;

function unit(call: AnswerDraftCall, op: Unit): AnswerDraftCall {
  const seq = Number(op.seq), bi = Number(op.bi);
  if (!Number.isInteger(seq) || seq <= call.seq || !Number.isInteger(bi) || bi < 0 || bi >= 8) return call;
  const raw = [...call.raw], blocks = [...call.blocks], open = [...call.open];
  const incoming = { ...call.incoming };
  let block = { ...raw[bi] };
  if (op.op === "block") {
    const value = op.value as Unit;
    block = block.type === value.type ? { ...block, ...value } : value;
    open[bi] = true;
  }
  if (op.op === "tab" || op.op === "child") {
    const tabs = [...(Array.isArray(block.tabs) ? block.tabs as Unit[] : [])];
    const ti = Number(op.op === "tab" ? op.index : op.tab);
    if (!Number.isInteger(ti) || ti < 0 || ti >= 5) return call;
    const tab = { ...(tabs[ti] ?? { label: "", blocks: [] }) };
    if (op.op === "tab") tab.label = op.label;
    else {
      const children = [...(tab.blocks as unknown[])]; children[Number(op.index)] = op.value; tab.blocks = children;
    }
    tabs[ti] = tab; block = { ...block, tabs };
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
    : block.type === "columns" || block.type === "group" ? Array.isArray(block.blocks) && block.blocks.length > 0
    : block.type === "tabs" ? Array.isArray(block.tabs) && block.tabs.some(tab => (tab as Unit)?.label && ((tab as Unit)?.blocks as unknown[])?.length)
    : block.type === "image" ? typeof block.img === "string"
    : ["callout", "text", "quote"].includes(String(block.type)) && typeof block.text === "string";
  if (block.type === "table" && !Array.isArray(block.rows)) block = { ...block, rows: [] };
  blocks[bi] = ready ? block as unknown as AnswerBlockView : null;
  return { ...call, seq, raw, blocks, open, incoming, lastBlock: Math.max(call.lastBlock, bi) };
}

function settle(call: AnswerDraftCall, outcome: Outcome): AnswerDraftCall {
  return outcome === "accepted"
    ? { ...call, outcome, raw: call.raw.slice(0, call.lastBlock + 1), blocks: call.blocks.slice(0, call.lastBlock + 1) }
    : { ...call, outcome };
}

/** An outcome names its call by provider call id; without one it settles the oldest open call. */
function end(draft: AnswerDraft, op: Unit, callId?: string): AnswerDraft {
  const outcome = String(op.outcome);
  if (outcome !== "accepted" && outcome !== "rejected") {
    if (!["delivered", "failed", "cancelled", "runtime_fault"].includes(outcome)) return draft;
    return { ...draft, present: outcome === "delivered" && draft.calls.some(call => call.outcome === "accepted") };
  }
  const named = callId ? draft.calls.findIndex(call => call.callId === callId) : -1;
  const index = named >= 0 ? named : draft.calls.findIndex(call => call.outcome === "streaming" && !(callId && call.callId));
  if (index < 0) return callId ? { ...draft, early: { ...draft.early, [callId]: outcome } } : draft;
  const calls = [...draft.calls];
  calls[index] = settle(calls[index], outcome);
  return { ...draft, calls };
}

/** A new round after a call that was not accepted is its retry and reconciles on its blocks; any other call is added. */
function callFor(draft: AnswerDraft, payload: Unit): [AnswerDraft, number] {
  const stream = String(payload.stream_id), id = `${stream}:${String(payload.call_index)}`;
  const found = draft.calls.findIndex(call => call.id === id);
  if (found >= 0) return [draft, found];
  const callId = typeof payload.call_id === "string" && payload.call_id ? payload.call_id : undefined;
  const calls = [...draft.calls], last = calls.at(-1);
  const retry = last !== undefined && last.stream !== stream && last.outcome !== "accepted";
  let call: AnswerDraftCall = { id, stream, callId, seq: 0, outcome: "streaming", incoming: {}, open: [], lastBlock: -1,
    raw: retry ? last.raw : [], blocks: retry ? last.blocks : [] };
  const early = callId ? draft.early[callId] : undefined;
  if (early) call = settle(call, early);
  if (retry) calls[calls.length - 1] = call;
  else calls.push(call);
  return [{ ...draft, calls }, calls.length - 1];
}

function apply(payload: Unit, previous?: AnswerDraft): AnswerDraft | undefined {
  if (typeof payload.turn_id !== "string" || typeof payload.session_id !== "string" || !Array.isArray(payload.ops)) return previous;
  let draft: AnswerDraft = previous ?? { sessionId: payload.session_id, turnId: payload.turn_id, calls: [], early: {}, present: true };
  const callId = typeof payload.call_id === "string" && payload.call_id ? payload.call_id : undefined;
  let index = -1;
  for (const op of payload.ops as Unit[]) {
    if (op.op === "end") { draft = end(draft, op, callId); continue; }
    if (!payload.stream_id) continue;
    if (index < 0) [draft, index] = callFor(draft, payload);
    const calls = [...draft.calls];
    calls[index] = unit(calls[index], op);
    draft = { ...draft, calls };
  }
  return draft;
}

/** The blocks a draft shows: a later call's block replaces an earlier one with the same id, as acceptance does. */
export function draftBlocks(draft: AnswerDraft): AnswerDraftBlock[] {
  const shown: AnswerDraftBlock[] = [];
  draft.calls.forEach((call, index) => {
    if (call.outcome === "rejected" && index < draft.calls.length - 1) return;
    call.raw.forEach((raw, bi) => {
      if (typeof raw.id === "string") {
        const previous = shown.findIndex(entry => entry.raw.id === raw.id);
        if (previous >= 0) shown.splice(previous, 1);
      }
      shown.push({ raw, view: call.blocks[bi] ?? null, open: call.open[bi] === true,
        incoming: call.outcome === "streaming" ? call.incoming[`${bi}:${raw.type === "table" ? "rows" : "items"}`] ?? [] : undefined });
    });
  });
  return shown;
}

export function draftStatus(draft: AnswerDraft): "preparing" | "prepared" | "rechecking" {
  const last = draft.calls.at(-1)?.outcome;
  if (last === "rejected") return "rechecking";
  return last === "accepted" && draft.calls.every(call => call.outcome !== "streaming") ? "prepared" : "preparing";
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
        // The snapshot replays each turn's calls in the order they arrived.
        drafts = {};
        for (const payload of ((event.payload as Unit)?.drafts ?? []) as Unit[]) {
          const draft = apply(payload, drafts[String(payload.turn_id)]); if (draft) drafts[draft.turnId] = draft;
        }
      } else {
        const payload = event.payload as Unit;
        const turn = String(payload.turn_id);
        const draft = apply(payload, drafts[turn]); if (draft) drafts[turn] = draft;
      }
    }
    // Terminal drafts are removed here, independently of virtualized reply rows.
    for (const [turn, draft] of Object.entries(drafts)) if (!draft.present) delete drafts[turn];
    const sessions: State["sessions"] = {};
    for (const draft of Object.values(drafts)) if (draft.calls.length) (sessions[draft.sessionId] ??= []).push(draft.turnId);
    for (const [id, turns] of Object.entries(sessions)) {
      if (JSON.stringify(turns) === JSON.stringify(state.sessions[id])) sessions[id] = state.sessions[id];
    }
    return { answerDrafts: drafts, sessions };
  });
}
export function abandonAnswerDrafts() {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined; pending = [];
  useAnswerDrafts.setState({ answerDrafts: {}, sessions: {} });
}
/** Canonical arrival owns handoff cleanup even when the reply row is offscreen. */
export function reconcileAnswerDrafts(events: TimelineEvent[]) {
  if (pending.length) {
    if (frame !== undefined) cancelAnimationFrame(frame);
    flush();
  }
  for (const event of events) {
    if (event.type !== "message.updated" && event.type !== "message.created") continue;
    const message = (event.payload as { message?: MessageRecord })?.message;
    if (message?.role === "assistant" && message.turn_id && (message.answer_blocks?.length || ["delivered", "failed", "cancelled"].includes(message.status ?? ""))) forgetAnswerDraft(message.turn_id);
  }
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
