import type { ConversationRole } from "./types.ts";

export type HistoricalSourceKind = "transcript" | "app_projection";
export type HistoricalProvenance = "trusted" | "recovered" | "discarded" | "ambiguous";

export interface HistoricalTranscriptRow {
  eventId: string;
  sessionId: string;
  kind: string;
  timestamp: string;
  transport?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface HistoricalAppProjectionRow {
  id: string;
  chat_id: string;
  role: string;
  text: string | null;
  created_at: string;
  conversation_session_id?: string | null;
  conversation_turn_id?: string | null;
  conversation_message_id?: string | null;
}

export interface HistoricalImportDecision {
  source_kind: HistoricalSourceKind;
  source_id: string;
  session_id: string;
  conversation_session_id: string | null;
  conversation_turn_id: string | null;
  conversation_message_id: string | null;
  provenance: HistoricalProvenance;
  admit: boolean;
  reason: string;
  role: Extract<ConversationRole, "user" | "assistant"> | null;
  created_at: string | null;
  audit_refs: string[];
  message: {
    role: Extract<ConversationRole, "user" | "assistant">;
    text: string;
    created_at: string;
  } | null;
}

export interface HistoricalRecoveryReportRow {
  source_kind: HistoricalSourceKind;
  source_id: string;
  session_id: string;
  conversation_session_id: string | null;
  conversation_turn_id: string | null;
  conversation_message_id: string | null;
  provenance: HistoricalProvenance;
  admit: boolean;
  reason: string;
  role: string | null;
  created_at: string | null;
  audit_refs: string[];
}

export interface HistoricalRecoveryMapping {
  source_kind: HistoricalSourceKind;
  source_id: string;
  conversation_session_id: string;
  conversation_message_id: string;
  status: "planned" | "imported" | "existing";
}

export interface HistoricalRecoveryReport {
  ok: true;
  dry_run: boolean;
  counts: {
    total: number;
    trusted: number;
    recovered: number;
    discarded: number;
    ambiguous: number;
    admissible: number;
    imported: number;
    skipped_existing: number;
  };
  rows: HistoricalRecoveryReportRow[];
  mappings: HistoricalRecoveryMapping[];
  privacy: {
    rawTextIncluded: false;
    secretsIncluded: false;
  };
}

export interface ImportOutcome {
  mapping: HistoricalRecoveryMapping | null;
  imported: boolean;
  skippedExisting: boolean;
}
