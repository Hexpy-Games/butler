import { TodoListStore } from "../../../work/todo-list.ts";
import {
  applyTurnLocalWorkOutcomeForSession,
  WorkStreamStore,
  type WorkStreamRecord,
} from "../../../work/work-stream.ts";
import type { RuntimeMessageLanguage } from "../../../output/messages.ts";
import { runtimeSemanticTodoItems } from "../progress/runtime-semantic-progress.ts";
import type { RuntimeSemanticProgressSafetyNet } from "../tool-execution/audited-executor-types.ts";
import type { ToolAuditEntry } from "../output/tool-types.ts";
import {
  latestValidationSuiteStatesFromAudit,
  unresolvedValidationFailureFromAudit,
} from "./validation-failure-guard.ts";

const VALIDATION_CONTINUATION_LIST_PREFIX = "validation-continuation-";

export function completeReportingWorkStreamBestEffort(input: {
  butlerData: string;
  sessionId: string;
  turnId?: string | null;
  audit: ToolAuditEntry[];
}): void {
  try {
    const validationFailure = unresolvedValidationFailureFromAudit(input.audit);
    if (validationFailure) {
      markActiveWorkStreamRecoverableBestEffort({
        butlerData: input.butlerData,
        sessionId: input.sessionId,
        turnId: input.turnId,
        reason: `Validation suite failed without a later passing receipt: ${validationFailure.suite}`,
      });
      return;
    }
    completeResolvedValidationContinuationStreamsBestEffort(input);
    applyTurnLocalWorkOutcomeForSession({
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      turnId: input.turnId,
      outcome: "completed",
      statusNote: "Final answer delivered.",
    });
  } catch {
    // Final WorkStream bookkeeping must not block final answer delivery.
  }
}

function completeResolvedValidationContinuationStreamsBestEffort(input: {
  butlerData: string;
  sessionId: string;
  audit: ToolAuditEntry[];
}): void {
  const passedSuites = new Set(
    latestValidationSuiteStatesFromAudit(input.audit)
      .filter((state) => state.passed)
      .map((state) => state.suite),
  );
  if (passedSuites.size === 0) return;
  const streamStore = new WorkStreamStore(input.butlerData);
  const todoStore = new TodoListStore(input.butlerData);
  for (const summary of streamStore.list({ sessionId: input.sessionId })) {
    const record = streamStore.read(summary.id);
    const listId = record?.todo_list_id ?? "";
    if (!record || !listId.startsWith(VALIDATION_CONTINUATION_LIST_PREFIX)) continue;
    const suite = listId.slice(VALIDATION_CONTINUATION_LIST_PREFIX.length);
    if (!passedSuites.has(suite)) continue;
    const todoRecord = todoStore.read(listId);
    if (!todoRecord) {
      streamStore.transition({
        id: record.id,
        state: "recoverable",
        statusNote: `Validation suite now has a later passing receipt: ${suite}`,
      });
      continue;
    }
    const completedTodos = todoRecord.items.map((item) => ({
      id: item.id,
      content: item.content,
      active_form: item.active_form,
      status: "completed" as const,
      phase: item.phase ?? undefined,
      priority: item.priority,
      blocked_by: item.blocked_by,
      note: item.note ?? `Validation suite passed later: ${suite}`,
    }));
    const todoView = todoStore.update({
      listId,
      title: todoRecord.title,
      items: completedTodos,
    });
    streamStore.updateFromTodoList({
      id: record.id,
      ownerSessionId: record.owner_session_id,
      projectId: record.project_id,
      listId,
      title: record.title,
      items: todoView.list.items,
    });
  }
}

export function completeRuntimeSemanticWorkStreamBestEffort(input: {
  butlerData: string;
  sessionId: string;
  originChatId?: string | null;
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
        originChatId: input.originChatId,
        projectId: input.projectId,
        listId: input.tracker.listId,
        title: todoView.list.title ?? input.tracker.title,
        items: todoView.list.items,
      });
      new WorkStreamStore(input.butlerData).transition({
        id: record.id,
        state: "recoverable",
        statusNote: `Validation suite failed without a later passing receipt: ${validationFailure.suite}`,
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
      originChatId: input.originChatId,
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
  turnId?: string | null;
  reason?: string;
}): WorkStreamRecord[] {
  try {
    const reason = safeTextForStatusNote(input.reason);
    return applyTurnLocalWorkOutcomeForSession({
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      turnId: input.turnId,
      outcome: "recoverable",
      statusNote: reason
        ? `Turn interrupted before final delivery; durable work can be resumed. Cause: ${reason}`
        : "Turn interrupted before final delivery; durable work can be resumed.",
    });
  } catch {
    // Recovery marking is best-effort and must not mask the original failure.
    return [];
  }
}

export function cancelActiveWorkStreamBestEffort(input: {
  butlerData: string;
  sessionId: string;
  turnId?: string | null;
}): void {
  try {
    applyTurnLocalWorkOutcomeForSession({
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      turnId: input.turnId,
      outcome: "cancelled",
      statusNote: "Turn cancelled before final delivery.",
    });
  } catch {
    // Cancellation bookkeeping must not mask the cancellation.
  }
}

function safeTextForStatusNote(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}
