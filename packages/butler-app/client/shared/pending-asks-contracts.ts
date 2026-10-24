/** Read projection over authority, questions, and App plan decisions. */
export type PendingAskKind = "approval" | "question" | "plan_decision" | "canon_proposal";
export type PendingAskState = "open" | "answered" | "resolved_in_chat" | "dismissed" | "superseded" | "closed";
export interface PendingAsk {
  ask_id: string;
  kind: PendingAskKind;
  session_id: string;
  source_session_id: string;
  source_turn_id: string;
  title: string;
  summary?: string;
  blocking: boolean;
  state: "open";
  created_at: string;
  actions: ("open" | "allow" | "deny" | "answer" | "accept" | "decline" | "dismiss")[];
}
export interface SessionPendingAsks {
  session_id: string;
  open_count: number;
  asks: PendingAsk[];
}
export interface GlobalPendingAsks {
  asks: (PendingAsk & { session_title: string })[];
  next_cursor: string | null;
}
export interface PendingAsksChanged {
  session_id: string;
  ask_id: string;
  kind: PendingAskKind;
  state: PendingAskState;
  open_count: number;
}
export interface PendingAsksBridge {
  getSessionPendingAsks?: (input: { sessionId: string }) => Promise<SessionPendingAsks>;
  getPendingAsks?: (input?: { limit?: number; before?: string }) => Promise<GlobalPendingAsks>;
  dismissPendingAsk?: (input: { sessionId: string; askId: string }) => Promise<{ dismissed: boolean }>;
}
