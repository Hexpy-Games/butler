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

test("update_todo_list resumes a recoverable list only when requested ids match open todos", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-work-tracking-reopen-"));
  try {
    const firstTurn = workTrackingHandler(butlerData, "turn-1");
    const recoverable = await firstTurn.update_todo_list({
      args: {
        list_id: "sandy-recoverable",
        title: "Sandy W3 continuation",
        todos: [{
          id: "w3-style-guard",
          content: "Implement W3 style guard",
          active_form: "Implementing W3 style guard",
          status: "in_progress",
          phase: "execution",
        }, {
          id: "w4-report",
          content: "Report W4 result",
          active_form: "Reporting W4 result",
          status: "pending",
          phase: "reporting",
        }],
      },
    });
    new WorkStreamStore(butlerData).transition({
      id: recoverable.work_stream.id,
      state: "recoverable",
    });

    const resumed = await workTrackingHandler(butlerData, "turn-2").update_todo_list({
      args: {
        list_id: "main",
        title: "Sandy W3 continuation",
        todos: [{
          id: "w3-style-guard",
          content: "Implement W3 style guard",
          active_form: "Implementing W3 style guard",
          status: "completed",
          phase: "execution",
        }, {
          id: "w4-report",
          content: "Report W4 result",
          active_form: "Reporting W4 result",
          status: "completed",
          phase: "reporting",
        }],
      },
    });

    expect(resumed.list_id).toBe("sandy-recoverable");
    expect(resumed.work_stream).toMatchObject({
      id: recoverable.work_stream.id,
      state: "complete",
      last_user_turn_id: "turn-2",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("update_todo_list rejects unrelated default updates while recoverable todos are open", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-work-tracking-reopen-"));
  try {
    const firstTurn = workTrackingHandler(butlerData, "turn-1");
    const recoverable = await firstTurn.update_todo_list({
      args: {
        list_id: "sandy-recoverable",
        title: "Sandy W3 continuation",
        todos: [{
          id: "w3-style-guard",
          content: "Implement W3 style guard",
          active_form: "Implementing W3 style guard",
          status: "in_progress",
          phase: "execution",
        }],
      },
    });
    new WorkStreamStore(butlerData).transition({
      id: recoverable.work_stream.id,
      state: "recoverable",
    });

    await expect(workTrackingHandler(butlerData, "turn-2").update_todo_list({
      args: {
        title: "Unrelated new work",
        todos: [{
          id: "inspect-new-issue",
          content: "Inspect a new issue",
          active_form: "Inspecting a new issue",
          status: "in_progress",
          phase: "execution",
        }],
      },
    })).rejects.toThrow("recoverable WorkStream already has open todo items");

    expect(new TodoListStore(butlerData).read("sandy-recoverable")?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "w3-style-guard",
        status: "in_progress",
      }),
    ]));
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("update_todo_list rejects partial overlap that would replace recoverable checklist shape", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-work-tracking-reopen-"));
  try {
    const firstTurn = workTrackingHandler(butlerData, "turn-1");
    const recoverable = await firstTurn.update_todo_list({
      args: {
        list_id: "sandy-recoverable",
        title: "Sandy W3 continuation",
        todos: [{
          id: "w3-style-guard",
          content: "Implement W3 style guard",
          active_form: "Implementing W3 style guard",
          status: "in_progress",
          phase: "execution",
        }, {
          id: "w4-report",
          content: "Report W4 result",
          active_form: "Reporting W4 result",
          status: "pending",
          phase: "reporting",
        }],
      },
    });
    new WorkStreamStore(butlerData).transition({
      id: recoverable.work_stream.id,
      state: "recoverable",
    });

    await expect(workTrackingHandler(butlerData, "turn-2").update_todo_list({
      args: {
        title: "Sandy W3 continuation",
        todos: [{
          id: "w3-style-guard",
          content: "Review W3 validation evidence",
          active_form: "Reviewing W3 validation evidence",
          status: "in_progress",
          phase: "review",
        }],
      },
    })).rejects.toThrow("recoverable WorkStream already has open todo items");

    expect(new TodoListStore(butlerData).read("sandy-recoverable")?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "w3-style-guard",
        content: "Implement W3 style guard",
        status: "in_progress",
        phase: "execution",
      }),
      expect.objectContaining({
        id: "w4-report",
        status: "pending",
      }),
    ]));
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("update_todo_list rejects explicit recoverable list overwrite when open todos are not preserved", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-work-tracking-reopen-"));
  try {
    const firstTurn = workTrackingHandler(butlerData, "turn-1");
    const recoverable = await firstTurn.update_todo_list({
      args: {
        list_id: "sandy-recoverable",
        title: "Sandy W3 continuation",
        todos: [{
          id: "w3-style-guard",
          content: "Implement W3 style guard",
          active_form: "Implementing W3 style guard",
          status: "in_progress",
          phase: "execution",
        }, {
          id: "w4-report",
          content: "Report W4 result",
          active_form: "Reporting W4 result",
          status: "pending",
          phase: "reporting",
        }],
      },
    });
    new WorkStreamStore(butlerData).transition({
      id: recoverable.work_stream.id,
      state: "recoverable",
    });

    await expect(workTrackingHandler(butlerData, "turn-2").update_todo_list({
      args: {
        list_id: "sandy-recoverable",
        title: "Review-only replacement",
        todos: [{
          id: "review",
          content: "Review prior work",
          active_form: "Reviewing prior work",
          status: "in_progress",
          phase: "review",
        }],
      },
    })).rejects.toThrow("recoverable WorkStream already has open todo items");

    expect(new TodoListStore(butlerData).read("sandy-recoverable")?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "w3-style-guard",
        content: "Implement W3 style guard",
        status: "in_progress",
        phase: "execution",
      }),
      expect.objectContaining({
        id: "w4-report",
        status: "pending",
      }),
    ]));
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("update_todo_list does not route across project scoped recoverable work", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-work-tracking-reopen-"));
  try {
    const firstTurn = workTrackingHandler(butlerData, "turn-1", "project-a");
    const recoverable = await firstTurn.update_todo_list({
      args: {
        list_id: "project-a-recoverable",
        title: "Project A recoverable",
        todos: [{
          id: "project-a-step",
          content: "Resume project A",
          active_form: "Resuming project A",
          status: "in_progress",
          phase: "execution",
        }],
      },
    });
    new WorkStreamStore(butlerData).transition({
      id: recoverable.work_stream.id,
      state: "recoverable",
    });

    const projectB = await workTrackingHandler(butlerData, "turn-2", "project-b").update_todo_list({
      args: {
        title: "Project B work",
        todos: [{
          id: "project-b-step",
          content: "Start project B",
          active_form: "Starting project B",
          status: "in_progress",
          phase: "execution",
        }],
      },
    });

    expect(projectB.list_id).toBe("turn-2:main");
    expect(projectB.work_stream.project_id).toBe("project-b");
    expect(projectB.work_stream.id).not.toBe(recoverable.work_stream.id);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("update_work_stream_state finds same-turn waiting stream without explicit id", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-work-tracking-reopen-"));
  try {
    const handler = workTrackingHandler(butlerData, "turn-waiting");
    const created = await handler.update_todo_list({
      args: {
        list_id: "waiting-decision",
        title: "Wait for decision",
        todos: [{
          id: "decide",
          content: "Wait for current turn decision",
          active_form: "Waiting for current turn decision",
          status: "in_progress",
          phase: "planning",
        }],
      },
    });
    const store = new WorkStreamStore(butlerData);
    store.transition({
      id: created.work_stream.id,
      state: "waiting_user",
    });

    const updated = await handler.update_work_stream_state({
      args: {
        state: "executing",
      },
    });

    expect(updated.work_stream).toMatchObject({
      id: created.work_stream.id,
      state: "executing",
      last_user_turn_id: "turn-waiting",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

function workTrackingHandler(butlerData: string, turnId: string, projectId = "project") {
  return createWorkTrackingToolHandlers({
    butlerData,
    sessionId: "session",
    projectId,
    turnId,
    todoListStore: new TodoListStore(butlerData),
    workStreamStore: new WorkStreamStore(butlerData),
  });
}
