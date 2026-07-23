import {
  getNativeMainStatePath,
  readNativeMainState,
} from "../../../../integrations/providers/native-main-state.ts";
import {
  isPidRunning,
  readServiceState,
} from "../../../../operations/service/native-service-supervisor.ts";
import type { SessionBindingStore } from "../../../../test-support/harness/session-store.ts";
import type { SessionTransportBinding } from "../../../../test-support/harness/contracts.ts";
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
import { appRuntimePolicy, stringArray } from "../../domain/runtime/app-runtime-policy.ts";
import {
  mergeTransportBindings,
  normalizeAppModelRef,
} from "./app-transport-metadata.ts";
import { sessionHintForRow } from "../../domain/sessions/session-read-model.ts";
import type {
  MessageRecord,
  SettingsView,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";
import type { RuntimeTurnEventInput } from "../../../../agent/events/turn-events.ts";
import {
  verifyTurnExecutionControls,
  type TurnExecutionControlsV1,
} from "../../../core/turn-execution-controls.ts";

export class AppTransportQueueStore {
  constructor(
    private readonly butlerData: string,
    private readonly butlerHome: string,
    private readonly serviceClient: ButlerServiceClient,
    private readonly sessionBindingStore: SessionBindingStore,
    private readonly messageFiles: AppMessageFileStore,
    private readonly getChatRow: (chatId: string) => ChatRow | null,
    private readonly getProjectRow: (projectId: string) => ProjectRow | null,
    private readonly getSettings: () => SettingsView,
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
  ) {}

  enqueueAppTransportTurn(input: {
    chatId: string;
    turnId: string;
    message: MessageRecord;
    text: string;
    executionControls: TurnExecutionControlsV1;
  }): TurnRecord {
    try {
      const executionControls = verifyTurnExecutionControls(
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
      this.ensureAppTransportSessionBinding({
        chatId: input.chatId,
        sessionId,
        project,
        sessionKind: chat?.kind ?? "chat",
        executionControls,
      });
      const queued = this.serviceClient.enqueueAppTurn(
        {
          chatId: input.chatId,
          messageId: input.message.id,
          turnId: input.turnId,
          text: input.text,
          timestamp: input.message.created_at,
          sessionId,
          accountId: APP_ACCOUNT,
          peerKind: "dm",
          senderId: APP_SENDER_ID,
          senderDisplayName: "Butler App",
          projectId: chat?.project_id ?? undefined,
          executionControls,
          attachments: this.messageFiles.attachmentsForTransport(
            input.message.id,
          ),
          rawSource: "app-server",
        },
        {
          source: "app-server",
          chatId: input.chatId,
          turnId: input.turnId,
        },
      );
      this.appendEvent("turn.queued", {
        session_id: input.chatId,
        turn_id: input.turnId,
        transport: APP_TRANSPORT,
        queue_id: queued.queueId,
        requested_model_ref: executionControls.model_ref,
        reasoning_effort: executionControls.reasoning_effort,
      });
      return this.getTurn(input.turnId);
    } catch (error) {
      return this.failAppTransportQueueHandoff(input, error);
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
    },
    error: unknown,
  ): TurnRecord {
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
  }

  private ensureAppTransportSessionBinding(input: {
    chatId: string;
    sessionId: string;
    project: ProjectRow | null;
    sessionKind: ChatRow["kind"];
    executionControls: TurnExecutionControlsV1;
  }): void {
    const existing = this.sessionBindingStore.getBySessionId(input.sessionId);
    const modelRef = normalizeAppModelRef(
      input.executionControls.model_ref ?? existing?.modelRef,
    );
    const appBinding: SessionTransportBinding = {
      transport: APP_TRANSPORT,
      accountId: APP_ACCOUNT,
      peerId: input.chatId,
    };
    const transportBindings = mergeTransportBindings([
      ...(existing?.transportBindings ?? []),
      appBinding,
    ]);
    const settings = this.getSettings();
    const runtimePolicy = appRuntimePolicy({
      existing: existing?.metadata?.runtimePolicy,
      accessMode: input.executionControls.access_mode,
      projectId: input.project?.id ?? existing?.projectId,
      sessionKind: input.sessionKind,
    });
    this.sessionBindingStore.upsert({
      sessionId: input.sessionId,
      role: existing?.role ?? "butler",
      projectId: input.project?.id ?? existing?.projectId,
      workspacePath:
        input.project?.workspace_path ??
        existing?.workspacePath ??
        this.butlerHome,
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId:
        modelRef.split("/", 1)[0] || existing?.modelProviderId || "openai",
      modelRef,
      runtimeSessionRef: existing?.runtimeSessionRef,
      providerThreadRef: existing?.providerThreadRef,
      lifecycleState: "active",
      transportBindings,
      metadata: {
        ...(existing?.metadata ?? {}),
        source: "app-server",
        appSessionKind: input.sessionKind,
        accessMode: input.executionControls.access_mode,
        requiredNativeTools: stringArray(runtimePolicy.requiredNativeTools),
        required_tools: stringArray(runtimePolicy.required_tools),
        requiredNativeToolProfiles: stringArray(
          runtimePolicy.requiredNativeToolProfiles,
        ),
        runtimePolicy,
        reasoning_effort: input.executionControls.reasoning_effort,
        plan_mode: input.executionControls.plan_mode,
        turnExecutionControls: input.executionControls,
        workerModelRules: settings.worker_model_rules,
      },
    });
  }
}
