import type { DeliveryResult, InboundEnvelope, OutboundAction, TransportAdapter } from "./contracts.ts";
import {
  verifyTurnExecutionControls,
  type TurnExecutionControlsV1,
} from "./turn-execution-controls.ts";
import type { VisualImageAdmissionResult } from "../../agent/image-attachment/contracts.ts";

export const APP_TRANSPORT = "app";
export const APP_ACCOUNT = "local";
export const APP_SENDER_ID = "app-user";

export interface AppInboundInput {
  chatId: string;
  messageId: string;
  turnId: string;
  turnAttempt?: number;
  text: string;
  timestamp: string;
  sessionId: string;
  signal?: AbortSignal;
  accountId?: string;
  peerKind?: InboundEnvelope["peer"]["kind"];
  peerParentId?: string;
  senderId?: string;
  senderDisplayName?: string;
  projectId?: string;
  executionControls?: TurnExecutionControlsV1;
  attachments?: InboundEnvelope["message"]["attachments"];
  imageAdmission?: VisualImageAdmissionResult;
  raw?: InboundEnvelope["raw"];
  rawSource?: string;
}

export function createAppInboundEnvelope(input: AppInboundInput): InboundEnvelope {
  const executionControls = input.executionControls
    ? verifyTurnExecutionControls(input.executionControls)
    : undefined;
  return {
    eventId: `${APP_TRANSPORT}:${input.messageId}`,
    signal: input.signal,
    transport: APP_TRANSPORT,
    accountId: input.accountId ?? APP_ACCOUNT,
    peer: {
      kind: input.peerKind ?? "dm",
      id: input.chatId,
      parentId: input.peerParentId,
    },
    sender: {
      id: input.senderId ?? APP_SENDER_ID,
      displayName: input.senderDisplayName ?? "Butler App",
    },
    message: {
      id: input.messageId,
      text: input.text,
      attachments: input.attachments,
      imageAdmission: input.imageAdmission,
      timestamp: input.timestamp,
    },
    routingHints: {
      sessionId: input.sessionId,
      projectId: input.projectId,
      turnId: input.turnId,
      ...(input.turnAttempt ? { turnAttempt: input.turnAttempt } : {}),
    },
    executionControls,
    raw: input.raw ?? {
      source: input.rawSource ?? "app-server",
    },
  };
}

export function createAppTransportAdapter(): TransportAdapter {
  return {
    id: APP_TRANSPORT,
    capabilities: {
      supportsThreads: false,
      supportsMessageEdit: true,
      supportsReactions: false,
      supportsAttachments: true,
      supportsStreamingEdits: false,
      supportsPresence: true,
      supportsActivityEvents: true,
      supportsArtifactViewer: true,
      supportsProgressDrafts: true,
      supportsFinalAggregateOnly: false,
    },
    async start() {
      // App inbound is queued by app-server. Butler core never polls the app UI.
    },
    async send(action: OutboundAction): Promise<DeliveryResult> {
      if (action.transport !== APP_TRANSPORT) {
        return {
          ok: false,
          error: `App adapter cannot send transport ${action.transport}`,
        };
      }
      return {
        ok: true,
        transportMessageId: `${APP_TRANSPORT}:${action.actionId}`,
      };
    },
  };
}
