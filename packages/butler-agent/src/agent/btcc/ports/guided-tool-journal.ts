export type OperationResultDeliveryState =
  | "pending_delivery"
  | "in_flight"
  | "acknowledged"
  | "reference_only";

export type GuidedToolJournalRecord = {
  callId: string;
  /** Durable insertion order when supplied by an ordered journal list; point reads may omit it. */
  journalOrdinal?: number;
  toolName: string;
  rawArguments: string;
  arguments: Record<string, unknown>;
  status: "started" | "awaiting_authority" | "completed" | "failed" | "cancelled";
  result?: unknown;
  /** Runtime-private mutation detail; excluded from replayable tool results. */
  changedFiles?: import("../../tools/file-tools/shared/changed-file-detail.ts").ChangedFileDetail[];
  resultSha256?: string;
  errorCode?: string;
  deliveryState?: OperationResultDeliveryState;
  deliveryRoundId?: string;
  deliveryResponseSha256?: string;
};

/** Required BTCC capability. SQLite is one adapter; the journal remains the authority. */
export interface GuidedToolJournal {
  start(input: {
    turnId: string;
    callId: string;
    toolName: string;
    rawArguments: string;
    arguments: Record<string, unknown>;
  }): void;
  finish(input: {
    callId: string;
    status: "completed" | "failed" | "cancelled";
    result?: unknown;
    changedFiles?: import("../../tools/file-tools/shared/changed-file-detail.ts").ChangedFileDetail[];
    errorCode?: string;
  }): void;
  find(callId: string): GuidedToolJournalRecord | null;
  findForTurn(turnId: string, callId: string): GuidedToolJournalRecord | null;
  list(turnId: string): GuidedToolJournalRecord[];
  admitResultDelivery(input: { turnId: string; callId: string }): void;
  beginResultDelivery(input: { turnId: string; callId: string; roundId: string }): void;
  releaseResultDeliveries(input: { turnId: string; roundId: string }): void;
  acknowledgeResultDeliveries(input: {
    turnId: string;
    roundId: string;
    responseSha256: string;
  }): void;
  promoteAcknowledgedResult(input: { turnId: string; callId: string }): void;
}

/** Scoped exact-read authority; it never performs a generic call-id lookup. */
export interface GuidedOperationResultReader {
  discover?(input: { turnId: string; workId?: string; cursor: number; through?: number; query: string; toolName?: string; status?: string; limit: number }): {
    entries: { callId: string; originTurnId?: string; ordinal: number; toolName: string; status: string; startedAt: string; requestPreview: string; resultSha256: string }[];
    through: number; nextCursor: number | null;
  };
  resolveResultReference(input: { turnId: string; callId: string }): {
    kind: "direct" | "work";
    resultRef: string;
    revision: number | null;
    workId?: string;
    sessionId?: string;
    scopeKind?: "session" | "project";
    scopeRef?: string;
  };
  readExactResultRange(input: {
    turnId: string;
    resultRef: string;
    resultSha256: string;
    revision: number | null;
    sessionId?: string;
    projectRef?: string;
    workId?: string;
    offset: number;
    length: number;
    source?: "request" | "result";
  }): {
    encoding: "base64";
    data: string;
    offset: number;
    length: number;
    totalBytes: number;
    nextOffset: number | null;
    resultSha256: string;
    complete: boolean;
  };
}
