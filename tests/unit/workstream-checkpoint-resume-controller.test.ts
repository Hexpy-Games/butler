import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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

test("checkpoint resume selects the sole recoverable WorkStream without reading continuation text", () => {
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

  expect(typoResume).toMatchObject({
    state: "resume_selected",
    reason: "sole_candidate",
    selected: {
      id: stream.id,
      checkpoint: {
        workStreamId: stream.id,
        todoListId: "recoverable-main",
        activeItems: expect.arrayContaining([
          expect.objectContaining({ id: "execute", status: "in_progress" }),
        ]),
      },
    },
  });
  expect(unrelatedText.selected?.id).toBe(stream.id);
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
  }).state).toBe("resume_selected");

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

test("checkpoint resume blocks waiting-user WorkStreams until structured user action is supplied", () => {
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
    state: "resume_blocked_user_action",
    reason: "waiting_user_action_required",
    blockers: [expect.objectContaining({ id: waiting.id })],
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

test("checkpoint resume falls back when a durable checkpoint is corrupted", () => {
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
    state: "fresh_turn",
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

function createRecoverableStream(input: {
  sessionId: string;
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
  listId: string;
  now: string;
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
    projectId: "butler",
    listId: input.listId,
    title: "Resume direct work",
    items: todoView.list.items,
    now: new Date(input.now),
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
