import { Database } from "bun:sqlite";
import type { RuntimeTurnEventInput } from "../../../../agent/events/turn-events.ts";
import type {
  ChatRow,
  MessageRow,
  ProjectRow,
  TurnRow,
} from "../core/records.ts";
import type { AppLimitedDelivery } from "./failure-ux-contract.ts";
import type {
  AppMessageFileStore,
  MessageFileRow,
} from "../../domain/message-files/message-file-store.ts";
import type { ProgressSummaryInput } from "../../domain/progress-summary/progress-row-normalizer.ts";
import type {
  MessageRecord,
  MessageRole,
  MessageStatus,
  ProgressSummaryRow,
  TurnRecord,
  TurnState,
} from "../../interface/protocol/app-protocol.ts";

export type AppQueuedTurnClaimStatus =
  | "unlinked"
  | "current"
  | "terminal"
  | "stale";

export interface AppTransportProjectionStoreOptions {
  db: Database;
  butlerData: string;
  butlerHome: string;
  messageFiles: AppMessageFileStore;
  getChatRow: (chatId: string) => ChatRow | null;
  getProjectRow: (projectId: string) => ProjectRow | null;
  getTurn: (turnId: string) => TurnRecord;
  getTurnRow: (turnId: string) => TurnRow | null;
  getMessageRow: (messageId: string) => MessageRow | null;
  getLatestAssistantMessageForTurn: (turnId: string) => MessageRow | null;
  insertMessage: (
    chatId: string,
    role: MessageRole,
    text: string,
    status: MessageStatus,
    options?: {
      clientMessageId?: string;
      turnId?: string;
      safeErrorCode?: string;
      retryable?: boolean;
      attachments?: MessageFileRow[];
    },
  ) => MessageRecord;
  insertOrReplaceAssistantReplies: (
    chatId: string,
    turnId: string,
    texts: string[],
    files?: MessageFileRow[],
    changedFiles?: string[],
  ) => MessageRecord[];
  updateTurnState: (
    turnId: string,
    state: TurnState,
    options: {
      safeStatusLabel: string;
      safeErrorCode?: string | null;
      retryable?: boolean;
      cancellable?: boolean;
      attempt?: number;
    },
  ) => TurnRecord;
  appendTerminalTurnStateChanged: (turn: TurnRecord) => void;
  appendEvent: (type: string, payload: Record<string, unknown>) => void;
  appendTurnEvent: (
    chatId: string,
    turnId: string,
    input: RuntimeTurnEventInput,
  ) => void;
  appendProgressSummaryEvent: (
    chatId: string,
    turnId: string,
    row: ProgressSummaryInput,
  ) => ProgressSummaryRow;
  hasTurnEventKind: (turnId: string, kind: string) => boolean;
  hasEquivalentProgressSummaryRow: (
    turnId: string,
    input: ProgressSummaryInput,
  ) => boolean;
  finalizeResponderLimitedDelivery: (
    chatId: string,
    turnId: string,
    limitedDelivery: AppLimitedDelivery,
  ) => { reply?: MessageRecord; replies: MessageRecord[]; turn: TurnRecord };
  finalizeCancelledTurn: (chatId: string, turnId: string) => TurnRecord;
  upsertAssistantTurnFailure: (
    chatId: string,
    turnId: string,
    safeError: { code: string; message: string },
    options?: { retryable?: boolean },
  ) => MessageRecord;
  runtimeFaultRecordForTurn: (turnId: string) => Record<string, unknown> | null;
  generatedSessionTitleHandler: (
    chatId: string,
    sourceText: string,
  ) => ((title: string) => void) | undefined;
  touchChat: (chatId: string) => void;
  drainQueuedSessionMessages: (chatId: string) => Promise<void>;
  queuedTurnClaimStatus: (
    chatId: string,
    turnId: string,
    claimId?: string,
  ) => AppQueuedTurnClaimStatus;
  fenceQueuedTurnClaim: (input: {
    chatId: string;
    turnId: string;
    claimId: string;
  }) => boolean;
  acknowledgeQueuedMessageForTurn: (input: {
    chatId: string;
    turnId: string;
    claimId: string;
    resultMessageId?: string;
    safeErrorCode?: string | null;
  }) => boolean;
}
