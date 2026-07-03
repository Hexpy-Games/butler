import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { persistTurnContextAtom } from "../../packages/butler-agent/src/agent/turn/turn-continuation-context.ts";
import { selectWorkStreamCheckpointResume } from "../../packages/butler-agent/src/agent/turn/workstream-checkpoint-resume-controller.ts";
import { WorkStreamStore, type WorkStreamRecord } from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import {
  TodoListStore,
  type TodoItemInput,
} from "../../packages/butler-agent/src/agent/work/todo-list.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-workstream-resume-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("checkpoint resume presents ordinary user turns to the model without reading continuation text", () => {
  const stream = createStream({
    sessionId: "butler/session",
    listId: "recoverable-main",
    now: "2026-07-03T00:00:00.000Z",
  });
  new WorkStreamStore(tempDir).transition({
    id: stream.id,
    state: "recoverable",
    now: new Date("2026-07-03T00:01:00.000Z"),
  });

  const typoResume = selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    userText: "개석해",
  });
  const unrelatedText = selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    userText: "완전히 다른 문장이어도 structured state만 봅니다",
  });

  expect(typoResume.state).toBe("resume_candidate_presented");
  expect(typoResume.reason).toBe("model_decision_required");
  expect(typoResume.candidates).toHaveLength(1);
  expect(typoResume.candidates[0]).toMatchObject({
    id: stream.id,
    checkpoint: {
      workStreamId: stream.id,
      todoListId: "recoverable-main",
      trackingMode: "local",
      closeoutStrategy: "local_workstream",
    },
  });
  expect(typoResume.candidates[0]!.checkpoint.activeItems).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "execute", status: "in_progress" }),
  ]));
  expect(typoResume.selected).toBeUndefined();
  expect(unrelatedText.state).toBe("resume_candidate_presented");
  expect(unrelatedText.candidates.map((candidate) => candidate.id)).toEqual([stream.id]);
  expect(unrelatedText.selected).toBeUndefined();
});

test("checkpoint resume hydrates origin turn, validation, evidence, and budget refs", () => {
  const stream = createStream({
    sessionId: "butler/session",
    originChatId: "app-chat",
    listId: "recoverable-with-origin",
    now: "2026-07-03T00:00:00.000Z",
    lastUserTurnId: "turn-origin",
  });
  new WorkStreamStore(tempDir).link({
    id: stream.id,
    plannedTaskIds: ["T-WCRC-VALIDATED"],
    now: new Date("2026-07-03T00:01:00.000Z"),
  });
  writeProjectLedgerIndex({
    projectId: "butler",
    records: [{ id: "T-WCRC-VALIDATED", kind: "task", title: "Validated task", status: "in_progress" }],
  });
  persistTurnContextAtom({
    butlerData: tempDir,
    sessionId: "butler/session",
    turnId: "turn-origin",
    state: "continuing",
    sourceErrorCode: "prompt_usage_model_call_budget_exhausted",
    reason: "budget",
    userRequest: { id: "msg-origin" },
    openToolPairs: [{ kind: "tool_result", id: "run-command-1" }],
    currentTurnWork: [{ kind: "workstream", id: stream.id }],
    currentTurnTodos: [{ kind: "todo_item", id: "execute" }],
    latestCompletionReview: { status: "gap", observationId: "review-gap-1" },
    unresolvedObservations: [{ kind: "validation_failure", id: "unit-gate" }],
    budgetSnapshot: {
      turnId: "turn-origin",
      modelRequestsUsed: 6,
      promptTokens: 100,
      cachedTokens: 20,
      outputTokens: 40,
      totalTokens: 140,
      maxModelCalls: 32,
      maxPromptTokens: 220000,
      maxOutputTokens: 80000,
      maxTotalTokens: 300000,
    },
  });

  const selection = selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    chatId: "app-chat",
    turnMetadata: { workstreamResume: { action: "resume", workStreamId: stream.id } },
  });

  expect(selection).toMatchObject({
    state: "resume_selected",
    selected: {
      checkpoint: {
        chatId: "app-chat",
        originatingTurnId: "turn-origin",
        userMessageId: "msg-origin",
        trackingMode: "ledger",
        closeoutStrategy: "ledger",
        blocker: { kind: "budget", reason: "prompt_usage_model_call_budget_exhausted" },
        budgetSnapshot: expect.objectContaining({
          turnId: "turn-origin",
          modelRequestsUsed: 6,
          maxModelCalls: 32,
        }),
        latestCompletionReview: { status: "gap", observationId: "review-gap-1" },
        evidenceRefs: expect.arrayContaining([
          expect.objectContaining({ kind: "project_ledger_task", id: "T-WCRC-VALIDATED" }),
          expect.objectContaining({ kind: "tool_result", id: "run-command-1" }),
        ]),
        validationRefs: expect.arrayContaining([
          expect.objectContaining({ kind: "completion_review", id: "review-gap-1" }),
          expect.objectContaining({ kind: "validation_failure", id: "unit-gate" }),
        ]),
      },
    },
  });
});

test("checkpoint resume honors structured cancel and new-objective actions only from metadata", () => {
  createStream({
    sessionId: "butler/session",
    listId: "active-main",
    now: "2026-07-03T00:00:00.000Z",
  });

  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    userText: "cancel이라는 단어만으로는 cancel_selected가 되면 안 됩니다",
  }).state).toBe("resume_candidate_presented");

  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    turnMetadata: { workstreamResume: { action: "cancel" } },
  })).toMatchObject({
    state: "cancel_selected",
    reason: "explicit_cancel",
  });
  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    turnMetadata: { workstreamResume: { action: "new_objective" } },
  })).toMatchObject({
    state: "cancel_selected",
    reason: "explicit_new_objective",
  });
});

test("checkpoint resume resolves multiple candidates by structured target or latest updated time", () => {
  const older = createRecoverableStream({
    sessionId: "butler/session",
    listId: "older",
    now: "2026-07-03T00:00:00.000Z",
    recoverableAt: "2026-07-03T00:01:00.000Z",
  });
  const newer = createRecoverableStream({
    sessionId: "butler/session",
    listId: "newer",
    now: "2026-07-03T00:02:00.000Z",
    recoverableAt: "2026-07-03T00:03:00.000Z",
  });

  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
  })).toMatchObject({
    state: "resume_candidate_presented",
    reason: "model_decision_required",
    candidates: [
      expect.objectContaining({ id: newer.id }),
      expect.objectContaining({ id: older.id }),
    ],
  });
  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    turnMetadata: { schedulerContinuation: { contextAtomId: "test-atom" } },
  })).toMatchObject({
    state: "resume_selected",
    reason: "latest_updated_at",
    selected: { id: newer.id },
  });
  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    turnMetadata: { workstreamResume: { action: "resume", workStreamId: older.id } },
  })).toMatchObject({
    state: "resume_selected",
    reason: "explicit_target",
    selected: { id: older.id },
  });
});

test("checkpoint resume presents equal-priority candidates to the model without prose heuristics", () => {
  const first = createRecoverableStream({
    sessionId: "butler/session",
    listId: "equal-a",
    now: "2026-07-03T00:00:00.000Z",
    recoverableAt: "2026-07-03T00:03:00.000Z",
  });
  const second = createRecoverableStream({
    sessionId: "butler/session",
    listId: "equal-b",
    now: "2026-07-03T00:01:00.000Z",
    recoverableAt: "2026-07-03T00:03:00.000Z",
  });

  const selection = selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    userText: `최종 답변에서 ${first.id} 완료라 했으니 그걸 이어서 처리해줘`,
  });

  expect(selection.state).toBe("resume_candidate_presented");
  expect(selection.reason).toBe("model_decision_required");
  expect(selection.candidates.map((candidate) => candidate.id).sort()).toEqual([
    first.id,
    second.id,
  ].sort());
  expect(selection.selected).toBeUndefined();
});

test("checkpoint resume treats explicit targets outside the current session as conflicts", () => {
  const otherSession = createRecoverableStream({
    sessionId: "butler/other-session",
    listId: "other-session",
    now: "2026-07-03T00:00:00.000Z",
    recoverableAt: "2026-07-03T00:01:00.000Z",
  });

  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/current-session",
    turnMetadata: { workstreamResume: { action: "resume", workStreamId: otherSession.id } },
  })).toMatchObject({
    state: "resume_conflict",
    reason: "explicit_target_missing",
    candidates: [],
  });
});

test("checkpoint resume rejects WorkStreams created for another chat in the same session", () => {
  const otherChat = createRecoverableStream({
    sessionId: "butler/shared-session",
    originChatId: "chat-a",
    listId: "chat-a-work",
    now: "2026-07-03T00:00:00.000Z",
    recoverableAt: "2026-07-03T00:01:00.000Z",
  });

  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/shared-session",
    chatId: "chat-b",
  })).toMatchObject({
    state: "fresh_turn",
    reason: "no_candidates",
    candidates: [],
  });
  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/shared-session",
    chatId: "chat-b",
    turnMetadata: { workstreamResume: { action: "resume", workStreamId: otherChat.id } },
  })).toMatchObject({
    state: "resume_conflict",
    reason: "explicit_target_missing",
    candidates: [],
  });
});

test("checkpoint resume rejects unknown-origin WorkStreams when the current chat is known", () => {
  const unknownOrigin = createRecoverableStream({
    sessionId: "butler/shared-session",
    listId: "unknown-origin-work",
    now: "2026-07-03T00:00:00.000Z",
    recoverableAt: "2026-07-03T00:01:00.000Z",
  });

  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/shared-session",
    chatId: "chat-b",
  })).toMatchObject({
    state: "fresh_turn",
    reason: "no_candidates",
    candidates: [],
  });
  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/shared-session",
    chatId: "chat-b",
    turnMetadata: { workstreamResume: { action: "resume", workStreamId: unknownOrigin.id } },
  })).toMatchObject({
    state: "resume_conflict",
    reason: "explicit_target_missing",
    candidates: [],
  });
});

test("checkpoint resume presents waiting-user WorkStreams for ordinary model decision and forces structured user action", () => {
  const waiting = createStream({
    sessionId: "butler/session",
    listId: "waiting",
    now: "2026-07-03T00:00:00.000Z",
  });
  new WorkStreamStore(tempDir).transition({
    id: waiting.id,
    state: "waiting_user",
    now: new Date("2026-07-03T00:01:00.000Z"),
  });

  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
  })).toMatchObject({
    state: "resume_candidate_presented",
    reason: "model_decision_required",
    candidates: [expect.objectContaining({
      id: waiting.id,
      checkpoint: expect.objectContaining({
        blocker: { kind: "user_action", reason: "waiting_user" },
      }),
    })],
  });
  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    turnMetadata: {
      workstreamResume: {
        action: "user_action_supplied",
        workStreamId: waiting.id,
      },
    },
  })).toMatchObject({
    state: "resume_selected",
    reason: "explicit_target",
    selected: { id: waiting.id },
  });
});

test("checkpoint resume blocks the system path when a durable checkpoint is corrupted", () => {
  const corrupted = createStream({
    sessionId: "butler/session",
    listId: "missing-todo",
    now: "2026-07-03T00:00:00.000Z",
  });
  rmSync(new TodoListStore(tempDir).listPath("missing-todo"), { force: true });

  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
  })).toMatchObject({
    state: "resume_blocked_system",
    reason: "no_valid_checkpoint",
    issues: [{ workStreamId: corrupted.id, code: "missing_todo_record" }],
  });
  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    turnMetadata: { workstreamResume: { action: "resume", workStreamId: corrupted.id } },
  })).toMatchObject({
    state: "resume_blocked_system",
    reason: "explicit_target_corrupted",
  });
});

test("checkpoint resume blocks ledger-governed WorkStreams when linked ledger records cannot hydrate", () => {
  const stream = createStream({
    sessionId: "butler/session",
    listId: "ledger-missing",
    now: "2026-07-03T00:00:00.000Z",
  });
  const linked = new WorkStreamStore(tempDir).link({
    id: stream.id,
    plannedTaskIds: ["T-MISSING-LEDGER"],
    now: new Date("2026-07-03T00:01:00.000Z"),
  });

  expect(selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
  })).toMatchObject({
    state: "resume_blocked_system",
    reason: "no_valid_checkpoint",
    issues: [{ workStreamId: linked!.id, code: "ledger_index_missing" }],
  });
});

function createRecoverableStream(input: {
  sessionId: string;
  originChatId?: string;
  listId: string;
  now: string;
  recoverableAt: string;
}): WorkStreamRecord {
  const stream = createStream(input);
  return new WorkStreamStore(tempDir).transition({
    id: stream.id,
    state: "recoverable",
    now: new Date(input.recoverableAt),
  });
}

function createStream(input: {
  sessionId: string;
  originChatId?: string;
  listId: string;
  now: string;
  lastUserTurnId?: string;
}): WorkStreamRecord {
  const todoView = new TodoListStore(tempDir).update({
    listId: input.listId,
    title: "Resume direct work",
    items: [
      todo({ id: "plan", content: "Plan the repair", status: "completed", phase: "planning" }),
      todo({ id: "execute", content: "Execute the repair", status: "in_progress", phase: "execution" }),
      todo({ id: "report", content: "Report the result", status: "pending", phase: "reporting" }),
    ],
    now: new Date(input.now),
  });
  return new WorkStreamStore(tempDir).updateFromTodoList({
    ownerSessionId: input.sessionId,
    originChatId: input.originChatId,
    projectId: "butler",
    listId: input.listId,
    title: "Resume direct work",
    items: todoView.list.items,
    now: new Date(input.now),
    lastUserTurnId: input.lastUserTurnId,
  });
}

function todo(input: {
  id: string;
  content: string;
  status: TodoItemInput["status"];
  phase: TodoItemInput["phase"];
  active_form?: string;
  priority?: TodoItemInput["priority"];
  blocked_by?: string[];
  note?: string;
}): TodoItemInput {
  return {
    ...input,
    active_form: input.active_form ?? input.content,
    priority: input.priority ?? "normal",
    blocked_by: input.blocked_by ?? [],
  };
}

function writeProjectLedgerIndex(input: {
  projectId: string;
  records: Array<Record<string, unknown>>;
}): void {
  const indexDir = join(tempDir, "project-ledger", "projects", input.projectId, "index");
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(join(indexDir, "project.json"), JSON.stringify({
    schema: "project-ledger.index.v1",
    records: input.records,
  }), "utf8");
}
