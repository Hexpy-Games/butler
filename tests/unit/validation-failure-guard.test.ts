import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  unresolvedValidationFailureFromAudit,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/validation-failure-guard.ts";
import {
  completeReportingWorkStreamBestEffort,
  completeRuntimeSemanticWorkStreamBestEffort,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/workstream-finalizers.ts";
import type { ToolAuditEntry } from "../../packages/butler-agent/src/agent/turn/native/output/tool-types.ts";
import { RUNTIME_SEMANTIC_TODO_LIST_ID } from "../../packages/butler-agent/src/agent/turn/direct-work-continuation.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import { TodoListStore } from "../../packages/butler-agent/src/agent/work/todo-list.ts";

test("validation guard keeps failed validation unresolved until the same command passes", () => {
  const failedTypecheck = commandAudit("npm run typecheck", 2);
  expect(unresolvedValidationFailureFromAudit([failedTypecheck])).toMatchObject({
    command: "npm run typecheck",
    exitCode: 2,
  });

  expect(unresolvedValidationFailureFromAudit([
    failedTypecheck,
    commandAudit("node -e 'console.log(1)'", 0),
  ])).toMatchObject({
    command: "npm run typecheck",
    exitCode: 2,
  });

  expect(unresolvedValidationFailureFromAudit([
    failedTypecheck,
    commandAudit("npm run typecheck", 0),
  ])).toBeNull();
});

test("validation guard recognizes direct npm test commands", () => {
  expect(unresolvedValidationFailureFromAudit([
    commandAudit("npm test -- tests/runtime-context-history-regression.test.ts", 1),
  ])).toMatchObject({
    command: "npm test -- tests/runtime-context-history-regression.test.ts",
    exitCode: 1,
  });
});

test("validation guard clears failed npm test with later node test success", () => {
  expect(unresolvedValidationFailureFromAudit([
    commandAudit("npm test -- tests/runtime-context-history-regression.test.ts", 1),
    commandAudit("node --test --import tsx tests/runtime-context-history-regression.test.ts", 0),
  ])).toBeNull();
});

test("runtime semantic finalizer leaves unresolved validation failures recoverable", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-validation-finalizer-"));
  try {
    completeRuntimeSemanticWorkStreamBestEffort({
      butlerData,
      sessionId: "session",
      projectId: "project",
      language: "ko",
      tracker: {
        source: "runtime",
        listId: RUNTIME_SEMANTIC_TODO_LIST_ID,
        title: "Run validation",
        lastExecutionLabel: "npm run typecheck",
      },
      audit: [commandAudit("npm run typecheck", 2)],
    });

    const stream = new WorkStreamStore(butlerData).list({
      sessionId: "session",
      includeTerminal: true,
    }).at(0);
    expect(stream).toMatchObject({
      state: "recoverable",
      current_phase: "review",
      todo_list_id: RUNTIME_SEMANTIC_TODO_LIST_ID,
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("reporting finalizer does not complete active work with unresolved validation failures", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-validation-finalizer-"));
  try {
    const todoView = new TodoListStore(butlerData).update({
      listId: "main",
      title: "Fix typecheck",
      items: [{
        id: "review",
        content: "Review validation",
        active_form: "Reviewing validation",
        status: "in_progress",
        phase: "review",
      }],
    });
    new WorkStreamStore(butlerData).updateFromTodoList({
      ownerSessionId: "session",
      projectId: "project",
      listId: "main",
      title: "Fix typecheck",
      items: todoView.list.items,
    });

    completeReportingWorkStreamBestEffort({
      butlerData,
      sessionId: "session",
      audit: [commandAudit("npm run typecheck", 2)],
    });

    const stream = new WorkStreamStore(butlerData).list({
      sessionId: "session",
      includeTerminal: true,
    }).at(0);
    expect(stream).toMatchObject({
      state: "recoverable",
      current_phase: "review",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

function commandAudit(command: string, exitCode: number): ToolAuditEntry {
  return {
    name: "run_command",
    args: { command },
    ok: exitCode === 0,
    result: {
      ok: exitCode === 0,
      command,
      cwd: "/workspace",
      exit_code: exitCode,
      timed_out: false,
      stdout: "",
      stderr: "",
    },
  };
}
