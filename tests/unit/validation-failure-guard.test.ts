import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  unresolvedValidationFailureFromAudit,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/validation-failure-guard.ts";
import { createEvidenceCapabilityReceipt } from "../../packages/butler-agent/src/agent/output/evidence/ledger.ts";
import { evidenceCapabilityReceiptsFromResult } from "../../packages/butler-agent/src/agent/output/evidence/receipts.ts";
import {
  completeReportingWorkStreamBestEffort,
  completeRuntimeSemanticWorkStreamBestEffort,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/workstream-finalizers.ts";
import type { ToolAuditEntry } from "../../packages/butler-agent/src/agent/turn/native/output/tool-types.ts";
import { RUNTIME_SEMANTIC_TODO_LIST_ID } from "../../packages/butler-agent/src/agent/turn/direct-work-continuation.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import { TodoListStore } from "../../packages/butler-agent/src/agent/work/todo-list.ts";

test("validation guard keeps failed validation unresolved until the same suite passes", () => {
  const failedTypecheck = validationAudit("typecheck", "failed");
  expect(unresolvedValidationFailureFromAudit([failedTypecheck])).toMatchObject({
    suite: "typecheck",
    result: "failed",
  });

  expect(unresolvedValidationFailureFromAudit([
    failedTypecheck,
    validationAudit("lint", "passed"),
  ])).toMatchObject({
    suite: "typecheck",
    result: "failed",
  });

  expect(unresolvedValidationFailureFromAudit([
    failedTypecheck,
    validationAudit("typecheck", "passed"),
  ])).toBeNull();
});

test("validation guard ignores command failures without validation receipts", () => {
  expect(unresolvedValidationFailureFromAudit([
    commandAudit("npm run typecheck", 2),
  ])).toBeNull();
});

test("validation guard resolves later passing receipts parsed from tool results", () => {
  const result = {
    evidence_capability_receipts: [
      validationReceipt("unit-tests", "failed"),
      validationReceipt("unit-tests", "passed"),
    ],
  };

  expect(unresolvedValidationFailureFromAudit([{
    name: "run_command",
    args: { command: "test", validation_suite: "unit-tests" },
    ok: true,
    result,
    evidenceCapabilityReceipts: evidenceCapabilityReceiptsFromResult(result),
  }])).toBeNull();
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
        lastExecutionLabel: "typecheck",
      },
      audit: [validationAudit("typecheck", "failed")],
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
      audit: [validationAudit("typecheck", "failed")],
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

test("reporting finalizer closes stale validation continuation after same suite passes", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-validation-finalizer-"));
  try {
    const sessionId = "session";
    const listId = "validation-continuation-sandy-targeted-tests-log";
    const todoView = new TodoListStore(butlerData).update({
      listId,
      title: "Recover failed sandy-targeted-tests-log validation",
      items: [{
        id: "inspect-failed-validation",
        content: "Inspect failed validation evidence",
        active_form: "Inspecting failed validation evidence",
        status: "completed",
        phase: "execution",
      }, {
        id: "patch-workspace-cause",
        content: "Patch the workspace cause if the failure is inside the codebase",
        active_form: "Comparing code against requested context history behavior",
        status: "in_progress",
        phase: "execution",
      }, {
        id: "rerun-validation",
        content: "Re-run the same validation suite and obtain a passing receipt",
        active_form: "Waiting to re-run same validation suite",
        status: "pending",
        phase: "review",
      }, {
        id: "report",
        content: "Report after same-suite validation passes",
        active_form: "Reporting validation result",
        status: "pending",
        phase: "reporting",
      }],
    });
    const created = new WorkStreamStore(butlerData).updateFromTodoList({
      ownerSessionId: sessionId,
      projectId: "project",
      listId,
      title: "Recover failed sandy-targeted-tests-log validation",
      items: todoView.list.items,
    });
    expect(created.state).toBe("executing");

    completeReportingWorkStreamBestEffort({
      butlerData,
      sessionId,
      audit: [
        validationAudit("sandy-targeted-tests-log", "failed"),
        validationAudit("sandy-targeted-tests-log", "passed"),
      ],
    });

    const stream = new WorkStreamStore(butlerData).read(created.id);
    expect(stream).toMatchObject({
      state: "complete",
      active_step_id: null,
    });
    expect(new WorkStreamStore(butlerData).activeForSession(sessionId)).toBeNull();
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

function validationAudit(
  suite: string,
  result: "passed" | "failed",
): ToolAuditEntry {
  return {
    name: "run_command",
    args: {
      command: suite,
      validation_suite: suite,
    },
    ok: result === "passed",
    result: {
      ok: result === "passed",
      command: suite,
      cwd: "/workspace",
      exit_code: result === "passed" ? 0 : 1,
      timed_out: false,
      stdout: "",
      stderr: "",
    },
    evidenceCapabilityReceipts: [validationReceipt(suite, result)],
  };
}

function validationReceipt(suite: string, result: "passed" | "failed") {
  return createEvidenceCapabilityReceipt({
    producer: { kind: "tool", name: "run_command" },
    capability: "validation_passed",
    evidence_kind: "execution_result",
    maturity: result === "passed" ? "verified" : "rejected",
    verified: result === "passed",
    confidence: result === "passed" ? 0.95 : 0.25,
    summary: result === "passed"
      ? "A validation suite completed successfully."
      : "A validation suite did not complete successfully.",
    scope: { suite, result },
  });
}
