import type { RuntimeTurnEventInput } from "../../../../agent/events/turn-events.ts";
import type {
  ChatKind,
  MessageFileRef,
  SessionControlState,
  SettingsView,
} from "../../interface/protocol/app-protocol.ts";
import type { DeliveryLimitationMetadata } from "../../infrastructure/transport/app-delivery-projection.ts";
import type { ProgressSummaryInput } from "../progress-summary/progress-row-normalizer.ts";

export interface AppMessageResponderInput {
  chatId: string;
  turnId: string;
  messageId: string;
  text: string;
  attachments?: MessageFileRef[];
  sessionKind: ChatKind;
  projectId?: string;
  projectWorkspacePath?: string;
  model?: string;
  reasoningEffort?: SettingsView["reasoning_effort"];
  accessMode?: SettingsView["access_mode"];
  planMode?: boolean;
  onSessionTitle?: (title: string) => void;
  onProgress?: (row: ProgressSummaryInput) => void;
  onTurnEvent?: (event: RuntimeTurnEventInput) => void;
  signal?: AbortSignal;
}

export interface AppMessageResponderFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array | ArrayBuffer | string;
}

export interface AppMessageResponderResult {
  texts: string[];
  files?: AppMessageResponderFile[];
  progress?: ProgressSummaryInput[];
  delivery?: DeliveryLimitationMetadata;
}

export type AppMessageResponder = (
  input: AppMessageResponderInput,
) => Promise<AppMessageResponderResult> | AppMessageResponderResult;

export interface SendMessageOptions {
  responderTimeoutMs?: number;
  controls?: SessionControlState;
  deferResponderTurns?: boolean;
  suppressAssistantReplies?: boolean;
}
