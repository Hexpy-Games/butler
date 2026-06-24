import { TodoListStore } from "../../../work/todo-list.ts";
import {
  completeReportingWorkStreamForSession,
  completeTurnLocalWorkStreamForSession,
  WorkStreamStore,
  workStreamTerminal,
} from "../../../work/work-stream.ts";
import type { RuntimeMessageLanguage } from "../../../output/messages.ts";
import { runtimeSemanticTodoItems } from "../progress/runtime-semantic-progress.ts";
import type { RuntimeSemanticProgressSafetyNet } from "../tool-execution/audited-executor-types.ts";
import type { ToolAuditEntry } from "../output/tool-types.ts";
import { unresolvedValidationFailureFromAudit } from "./validation-failure-guard.ts";

export function completeReportingWorkStreamBestEffort(input: {
  butlerData: string;
  sessionId: string;
  audit: ToolAuditEntry[];
}): void {
  try {
    const validationFailure = unresolvedValidationFailureFromAudit(input.audit);
    if (validationFailure) {
      markActiveWorkStreamRecoverableBestEffort({
        butlerData: input.butlerData,
        sessionId: input.sessionId,
        reason: `Validation command failed without a later passing run: ${validationFailure.command}`,
      });
      return;
    }
    const completed = completeTurnLocalWorkStreamForSession({
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      statusNote: "Final answer delivered.",
    });
    if (!completed) {
      completeReportingWorkStreamForSession({
        butlerData: input.butlerData,
        sessionId: input.sessionId,
        statusNote: "Final answer delivered.",
      });
    }
  } catch {
    // Final WorkStream bookkeeping must not block final answer delivery.
  }
}

export function completeRuntimeSemanticWorkStreamBestEffort(input: {
  butlerData: string;
  sessionId: string;
  projectId?: string;
  tracker: RuntimeSemanticProgressSafetyNet;
  language: RuntimeMessageLanguage;
  audit: ToolAuditEntry[];
}): void {
  if (input.tracker.source !== "runtime") return;
  try {
    const validationFailure = unresolvedValidationFailureFromAudit(input.audit);
    if (validationFailure) {
      const todoView = new TodoListStore(input.butlerData).update({
        listId: input.tracker.listId,
        title: input.tracker.title,
        items: runtimeSemanticTodoItems({
          language: input.language,
          executionLabel: input.tracker.lastExecutionLabel,
          state: "review",
        }),
      });
      const record = new WorkStreamStore(input.butlerData).updateFromTodoList({
        ownerSessionId: input.sessionId,
        projectId: input.projectId,
        listId: input.tracker.listId,
        title: todoView.list.title ?? input.tracker.title,
        items: todoView.list.items,
      });
      new WorkStreamStore(input.butlerData).transition({
        id: record.id,
        state: "recoverable",
        statusNote: `Validation command failed without a later passing run: ${validationFailure.command}`,
      });
      return;
    }
    const todoView = new TodoListStore(input.butlerData).update({
      listId: input.tracker.listId,
      title: input.tracker.title,
      items: runtimeSemanticTodoItems({
        language: input.language,
        executionLabel: input.tracker.lastExecutionLabel,
        state: "complete",
      }),
    });
    new WorkStreamStore(input.butlerData).updateFromTodoList({
      ownerSessionId: input.sessionId,
      projectId: input.projectId,
      listId: input.tracker.listId,
      title: todoView.list.title ?? input.tracker.title,
      items: todoView.list.items,
    });
  } catch {
    // Synthetic progress bookkeeping must never block final delivery.
  }
}

export function markActiveWorkStreamRecoverableBestEffort(input: {
  butlerData: string;
  sessionId: string;
  reason?: string;
}): void {
  try {
    const store = new WorkStreamStore(input.butlerData);
    const record = store.activeForSession(input.sessionId);
    if (!record || workStreamTerminal(record.state) || record.state === "recoverable") return;
    const reason = safeTextForStatusNote(input.reason);
    store.transition({
      id: record.id,
      state: "recoverable",
      statusNote: reason
        ? `Turn interrupted before final delivery; durable work can be resumed. Cause: ${reason}`
        : "Turn interrupted before final delivery; durable work can be resumed.",
    });
  } catch {
    // Recovery marking is best-effort and must not mask the original failure.
  }
}

function safeTextForStatusNote(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}
