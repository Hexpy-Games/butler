import type { RuntimeTurnEventInput } from "../../../../agent/events/turn-events.ts";
import type { AppMessageFileStore } from "../message-files/message-file-store.ts";
import type { ChatRow, ProjectRow } from "../../infrastructure/core/records.ts";
import type {
  AppMessageResponder,
  AppMessageResponderResult,
  SendMessageOptions,
} from "./message-responder-contract.ts";
import type { ProgressSummaryInput } from "../progress-summary/progress-row-normalizer.ts";
import type { SettingsView } from "../../interface/protocol/app-protocol.ts";
import { runResponderWithTimeout } from "../../infrastructure/transport/responder-timeout.ts";

export class AppResponderRuntime {
  private readonly activeTurnControllers = new Map<string, AbortController>();

  constructor(
    private readonly input: {
      messageFiles: AppMessageFileStore;
      getChatRow: (chatId: string) => ChatRow | null;
      getProjectRow: (projectId: string) => ProjectRow | null;
      getSettings: () => SettingsView;
      generatedSessionTitleHandler: (
        chatId: string,
        sourceText: string,
      ) => ((title: string) => void) | undefined;
    },
  ) {}

  cancel(turnId: string): boolean {
    const controller = this.activeTurnControllers.get(turnId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async run(input: {
    chatId: string;
    turnId: string;
    messageId: string;
    text: string;
    responder?: AppMessageResponder;
    options?: SendMessageOptions;
    onProgress?: (row: ProgressSummaryInput) => void;
    onTurnEvent?: (event: RuntimeTurnEventInput) => void;
  }): Promise<AppMessageResponderResult> {
    const chat = this.input.getChatRow(input.chatId);
    const project = chat?.project_id
      ? this.input.getProjectRow(chat.project_id)
      : null;
    if (!input.responder) {
      throw new Error("App responder is not configured for direct execution.");
    }
    const controller = new AbortController();
    this.activeTurnControllers.set(input.turnId, controller);
    try {
      return await runResponderWithTimeout(
        input.responder,
        {
          chatId: input.chatId,
          turnId: input.turnId,
          messageId: input.messageId,
          text: input.text,
          attachments: this.input.messageFiles.refsForMessage(input.messageId),
          sessionKind: chat?.kind ?? "chat",
          projectId: chat?.project_id ?? undefined,
          projectWorkspacePath: project?.workspace_path,
          model: input.options?.controls?.model,
          reasoningEffort: input.options?.controls?.reasoning_effort,
          accessMode: input.options?.controls?.access_mode,
          planMode: input.options?.controls?.plan_mode,
          onSessionTitle: this.input.generatedSessionTitleHandler(
            input.chatId,
            input.text,
          ),
          onProgress: input.onProgress,
          onTurnEvent: input.onTurnEvent,
        },
        input.options?.responderTimeoutMs,
        controller.signal,
      );
    } finally {
      if (this.activeTurnControllers.get(input.turnId) === controller) {
        this.activeTurnControllers.delete(input.turnId);
      }
    }
  }
}
