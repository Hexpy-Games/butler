import {
  getNativeMainStatePath,
  readNativeMainState,
} from "../../../../integrations/providers/native-main-state.ts";
import {
  isPidRunning,
  readServiceState,
} from "../../../../operations/service/native-service-supervisor.ts";
import type { ButlerServiceClient } from "../../../core/client.ts";
import {
  APP_ACCOUNT,
  APP_SENDER_ID,
  APP_TRANSPORT,
} from "../../../core/app-transport.ts";
import type { AppMessageFileStore } from "../../domain/message-files/message-file-store.ts";
import type { ProjectRow, ChatRow } from "../core/records.ts";
import { appSafeResponderError } from "./failure-ux-contract.ts";
import { APP_TURN_QUEUE_FAILED_CODE } from "./btcc-public-projection.ts";
import { safeTurnFailureEventPayload } from "./turn-failure-projection.ts";
import { sessionHintForRow } from "../../domain/sessions/session-read-model.ts";
import type {
  MessageRecord,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";
import type { RuntimeTurnEventInput } from "../../../../agent/events/turn-events.ts";
import type { VisualImageAdmissionResult } from "../../../../agent/image-attachment/contracts.ts";
import {
  verifyTurnExecutionControls,
  type TurnExecutionControlsV1,
} from "../../../core/turn-execution-controls.ts";

export class AppTransportQueueStore {
  constructor(
    private readonly butlerData: string,
    private readonly serviceClient: ButlerServiceClient,
    private readonly messageFiles: AppMessageFileStore,
    private readonly getChatRow: (chatId: string) => ChatRow | null,
    private readonly getProjectRow: (projectId: string) => ProjectRow | null,
    private readonly getTurn: (turnId: string) => TurnRecord,
    private readonly appendEvent: (
      type: string,
      payload: Record<string, unknown>,
    ) => void,
    private readonly appendTurnEvent: (
      chatId: string,
      turnId: string,
      event: RuntimeTurnEventInput,
    ) => void,
    private readonly updateTurnState: (
      turnId: string,
      state: TurnRecord["state"],
      options: {
        safeStatusLabel: string;
        safeErrorCode?: string | null;
        retryable?: boolean;
        cancellable?: boolean;
        attempt?: number;
      },
    ) => TurnRecord,
    private readonly appendTerminalTurnStateChanged: (
      turn: TurnRecord,
    ) => void,
    private readonly runInTransaction: <T>(callback: () => T) => T,
    private readonly fenceQueuedTurnClaim: (input: {
      chatId: string;
      turnId: string;
      claimId: string;
    }) => boolean,
  ) {}

  enqueueAppTransportTurn(input: {
    chatId: string;
    turnId: string;
    message: MessageRecord;
    text: string;
    executionControls: TurnExecutionControlsV1;
    queueClaimId?: string;
    queueReplay?: boolean;
    visualAdmission?: VisualImageAdmissionResult;
    authorityRequestRef?: string;
  }): TurnRecord {
    let transportInput: Parameters<ButlerServiceClient["enqueueAppTurn"]>[0];
    let turnBeforeEnqueue: TurnRecord;
    let executionControls: TurnExecutionControlsV1;
    try {
      executionControls = verifyTurnExecutionControls(
        input.executionControls,
      );
      if (
        executionControls.turn_id !== input.turnId ||
        executionControls.session_id !== input.chatId
      ) {
        throw new Error("turn_execution_controls_identity_mismatch");
      }
      this.assertAppTransportExecutorReady();
      const chat = this.getChatRow(input.chatId);
      const project = chat?.project_id
        ? this.getProjectRow(chat.project_id)
        : null;
      const sessionId = sessionHintForRow(input.chatId);
      turnBeforeEnqueue = this.getTurn(input.turnId);
      transportInput = {
        chatId: input.chatId,
        messageId: input.message.id,
        turnId: input.turnId,
        turnAttempt: turnBeforeEnqueue.attempt,
        text: input.text,
        timestamp: input.message.created_at,
        sessionId,
        accountId: APP_ACCOUNT,
        peerKind: "dm",
        senderId: APP_SENDER_ID,
        senderDisplayName: "Butler App",
        projectId: chat?.project_id ?? undefined,
        executionControls,
        appQueueClaimId: input.queueClaimId,
        appTurnContext: {
          version: 1,
          session: {
            id: input.chatId,
            kind: chat?.kind === "project" ? "project" : "chat",
          },
          conversation: {
            chatId: input.chatId,
            userMessageId: input.message.id,
            turnId: input.turnId,
            turnAttempt: turnBeforeEnqueue.attempt,
          },
          ...(project ? {
            project: {
              id: project.id,
              workspacePath: project.workspace_path,
              ...(project.ledger_project_id
                ? { ledgerProjectId: project.ledger_project_id }
                : {}),
            },
          } : {}),
          model: {
            requestedModelRef: executionControls.model_ref,
            reasoningEffort: executionControls.reasoning_effort,
          },
          ...(input.authorityRequestRef
            ? { authorityRequestRef: input.authorityRequestRef }
            : {}),
        },
        attachments: this.messageFiles.attachmentsForTransport(
          input.message.id,
          input.visualAdmission,
        ),
        imageAdmission: input.visualAdmission,
        rawSource: "app-server",
      };
    } catch (error) {
      return this.failAppTransportQueueHandoff(input, error);
    }

    let queued: ReturnType<ButlerServiceClient["enqueueAppTurn"]>;
    try {
      queued = this.serviceClient.enqueueAppTurn(
        transportInput,
        {
          source: "app-server",
          chatId: input.chatId,
          turnId: input.turnId,
        },
      );
    } catch (firstError) {
      // The existing production client exposes the canonical idempotent Native
      // lookup so a client exception after commit cannot be mistaken for a
      // pre-commit failure. A lost App claim is fenced before this
      // reconciliation so a stale owner cannot inspect or enqueue it.
      if (input.queueClaimId && !this.fenceQueuedTurnClaim({
        chatId: input.chatId,
        turnId: input.turnId,
        claimId: input.queueClaimId,
      })) throw new Error("queued_message_claim_lost", { cause: firstError });
      const committed = this.serviceClient.findAppTurn(transportInput);
      if (committed) {
        queued = committed;
      } else {
        return this.failAppTransportQueueHandoff(input, firstError);
      }
    }

    try {
      if (!input.queueReplay) {
        this.appendEvent("turn.queued", {
          session_id: input.chatId,
          turn_id: input.turnId,
          transport: APP_TRANSPORT,
          queue_id: queued.queueId,
          requested_model_ref: executionControls.model_ref,
          reasoning_effort: executionControls.reasoning_effort,
        });
      }
      return this.getTurn(input.turnId);
    } catch {
      // Native enqueue is already durable. Leave the exact App claim and
      // thinking Turn recoverable; the production transcript/projection path
      // is the canonical source of the eventual terminal result.
      return turnBeforeEnqueue;
    }
  }

  private assertAppTransportExecutorReady(): void {
    const nativeState = readNativeMainState(
      getNativeMainStatePath(this.butlerData),
    );
    if (nativeState && isPidRunning(nativeState.pid)) return;
    const state = readServiceState(this.butlerData, "butler-main");
    if (state && isPidRunning(state.pid)) return;
    if (nativeState) {
      throw new Error(`Butler Agent executor is stale (pid ${nativeState.pid}).`);
    }
    if (state) {
      throw new Error(`Butler Agent executor is stale (pid ${state.pid}).`);
    }
  }

  private failAppTransportQueueHandoff(
    input: {
      chatId: string;
      turnId: string;
      queueClaimId?: string;
    },
    error: unknown,
  ): TurnRecord {
    return this.runInTransaction(() => {
      if (input.queueClaimId && !this.fenceQueuedTurnClaim({
        chatId: input.chatId,
        turnId: input.turnId,
        claimId: input.queueClaimId,
      })) throw new Error("queued_message_claim_lost");
      const safeError = appSafeResponderError(error);
      this.appendTurnEvent(input.chatId, input.turnId, {
        kind: "turn.failed",
        payload: safeTurnFailureEventPayload({
          code: APP_TURN_QUEUE_FAILED_CODE,
          message:
            "Butler could not queue this request for execution. Retry the turn.",
          cause: safeError.cause ?? safeError.message,
        }),
      });
      const failedTurn = this.updateTurnState(input.turnId, "failed", {
        safeStatusLabel: "Failed",
        retryable: false,
        cancellable: false,
        safeErrorCode: APP_TURN_QUEUE_FAILED_CODE,
      });
      this.appendTerminalTurnStateChanged(failedTurn);
      this.appendEvent("turn.queue_failed", {
        session_id: input.chatId,
        turn_id: input.turnId,
        transport: APP_TRANSPORT,
        safe_error_code: APP_TURN_QUEUE_FAILED_CODE,
      });
      return failedTurn;
    });
  }

}
