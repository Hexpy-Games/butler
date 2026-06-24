import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createWorkTrackingToolHandlers } from "../../packages/butler-agent/src/agent/tools/work-tracking/shared.ts";
import { TodoListStore } from "../../packages/butler-agent/src/agent/work/todo-list.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";

test("update_todo_list does not reopen a completed same-turn work stream", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-work-tracking-reopen-"));
  try {
    const listId = "validation-continuation-sandy-targeted-tests-log";
    const handler = workTrackingHandler(butlerData, "turn-1");
    const completed = await handler.update_todo_list({
      args: {
        list_id: listId,
        title: "Recover failed validation",
        todos: [{
          id: "rerun-validation",
          content: "Re-run validation",
          active_form: "Re-ran validation",
          status: "completed",
          phase: "review",
        }, {
          id: "report",
          content: "Report validation result",
          active_form: "Reported validation result",
          status: "completed",
          phase: "reporting",
        }],
      },
    });

    const reopened = await handler.update_todo_list({
      args: {
        list_id: listId,
        title: "Fix failed validation",
        todos: [{
          id: "inspect-failure",
          content: "Inspect failed validation evidence",
          active_form: "Inspecting failed validation evidence",
          status: "in_progress",
          phase: "execution",
        }, {
          id: "rerun-validation",
          content: "Re-run validation",
          active_form: "Re-running validation",
          status: "pending",
          phase: "review",
        }],
      },
    });

    expect(reopened).toMatchObject({
      ignored: true,
      reason: "completed_work_stream_reopen_ignored",
      work_stream: {
        id: completed.work_stream.id,
        state: "complete",
        last_user_turn_id: "turn-1",
      },
    });
    expect(new TodoListStore(butlerData).read(listId)?.items).toMatchObject([{
      id: "rerun-validation",
      status: "completed",
    }, {
      id: "report",
      status: "completed",
    }]);
    expect(new WorkStreamStore(butlerData).list({
      sessionId: "session",
      includeTerminal: true,
    })).toHaveLength(1);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("update_todo_list allows a later turn to start a new revision", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-work-tracking-reopen-"));
  try {
    const listId = "validation-continuation-sandy-targeted-tests-log";
    const firstTurn = workTrackingHandler(butlerData, "turn-1");
    const completed = await firstTurn.update_todo_list({
      args: {
        list_id: listId,
        title: "Recover failed validation",
        todos: [{
          id: "rerun-validation",
          content: "Re-run validation",
          active_form: "Re-ran validation",
          status: "completed",
          phase: "review",
        }, {
          id: "report",
          content: "Report validation result",
          active_form: "Reported validation result",
          status: "completed",
          phase: "reporting",
        }],
      },
    });
    const secondTurn = workTrackingHandler(butlerData, "turn-2");
    const reopened = await secondTurn.update_todo_list({
      args: {
        list_id: listId,
        title: "Fix later validation",
        todos: [{
          id: "inspect-failure",
          content: "Inspect later validation evidence",
          active_form: "Inspecting later validation evidence",
          status: "in_progress",
          phase: "execution",
        }],
      },
    });

    expect(reopened.work_stream).toMatchObject({
      state: "executing",
      last_user_turn_id: "turn-2",
    });
    expect(reopened.work_stream.id).not.toBe(completed.work_stream.id);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

function workTrackingHandler(butlerData: string, turnId: string) {
  return createWorkTrackingToolHandlers({
    butlerData,
    sessionId: "session",
    projectId: "project",
    turnId,
    todoListStore: new TodoListStore(butlerData),
    workStreamStore: new WorkStreamStore(butlerData),
  });
}
