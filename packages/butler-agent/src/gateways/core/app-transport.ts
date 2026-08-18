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
  appQueueClaimId?: string;
  attachments?: InboundEnvelope["message"]["attachments"];
  imageAdmission?: VisualImageAdmissionResult;
  raw?: InboundEnvelope["raw"];
  rawSource?: string;
  appTurnContext?: InboundEnvelope["appTurnContext"];
}

export interface AppCancellationInput {
  chatId: string;
  sessionId: string;
  turnId: string;
  requestId: string;
  requestedAt: string;
  appQueueClaimId?: string;
}

export function createAppInboundEnvelope(input: AppInboundInput): InboundEnvelope {
  const executionControls = input.executionControls
    ? verifyTurnExecutionControls(input.executionControls)
    : undefined;
  if (input.appTurnContext) {
    verifyAppTurnContext(input.appTurnContext, input, executionControls);
  }
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
      ...(input.appQueueClaimId ? { appQueueClaimId: input.appQueueClaimId } : {}),
    },
    executionControls,
    appTurnContext: input.appTurnContext,
    raw: input.raw ?? {
      source: input.rawSource ?? "app-server",
    },
  };
}

function verifyAppTurnContext(
  context: NonNullable<InboundEnvelope["appTurnContext"]>,
  input: AppInboundInput,
  controls: TurnExecutionControlsV1 | undefined,
): void {
  if (
    !controls ||
    context.version !== 1 ||
    context.session.id !== input.chatId ||
    context.conversation.chatId !== input.chatId ||
    context.conversation.userMessageId !== input.messageId ||
    context.conversation.turnId !== input.turnId ||
    !Number.isSafeInteger(context.conversation.turnAttempt) ||
    context.conversation.turnAttempt < 1 ||
    context.model.requestedModelRef !== controls.model_ref ||
    context.model.reasoningEffort !== controls.reasoning_effort
  ) {
    throw new Error("app_turn_context_identity_mismatch");
  }
  for (const value of [
    context.session.id,
    context.conversation.chatId,
    context.conversation.userMessageId,
    context.conversation.turnId,
    context.project?.id,
    context.project?.ledgerProjectId,
  ]) {
    if (value !== undefined && (!value.trim() || value.length > 512)) {
      throw new Error("app_turn_context_value_invalid");
    }
  }
  if (context.project && (
    !context.project.workspacePath.trim() ||
    context.project.workspacePath.length > 4_096
  )) {
    throw new Error("app_turn_context_workspace_invalid");
  }
}

export function createAppCancellationEnvelope(
  input: AppCancellationInput,
): InboundEnvelope {
  return {
    eventId: `${APP_TRANSPORT}:cancel:${input.requestId}`,
    transport: APP_TRANSPORT,
    accountId: APP_ACCOUNT,
    peer: { kind: "dm", id: input.chatId },
    sender: { id: APP_SENDER_ID, displayName: "Butler App" },
    message: {
      id: input.requestId,
      timestamp: input.requestedAt,
    },
    routingHints: {
      sessionId: input.sessionId,
      turnId: input.turnId,
      ...(input.appQueueClaimId ? { appQueueClaimId: input.appQueueClaimId } : {}),
    },
    control: {
      kind: "cancel_turn",
      requestId: input.requestId,
      turnId: input.turnId,
      requestedAt: input.requestedAt,
    },
    raw: { source: "app-server" },
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
