/** Read projection over authority approvals and questions; canon proposals can join later. */
export type PendingAskKind = "approval" | "question" | "canon_proposal";
export type PendingAskState = "open" | "answered" | "resolved_in_chat" | "dismissed" | "superseded" | "closed" | "applied" | "cancelled" | "stale";
export interface PendingAsk {
  ask_id: string;
  kind: PendingAskKind;
  session_id: string;
  source_session_id: string;
  source_turn_id: string;
  source_message_id: string | null;
  source_call_id: string | null;
  deferred: boolean;
  waiting_since: string;
  title: string;
  summary?: string;
  target_label?: string;
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
