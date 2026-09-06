import { expect, test } from "bun:test";
import { projectLedgerNativeNextHints } from "../../packages/butler-agent/src/agent/tools/project-ledger/recovery-hints.ts";
import { runCommandToolDefinition } from "../../packages/butler-agent/src/agent/tools/run-command/run_command/definition.ts";

test("Ledger hints inspect the actual scoped record and never promote incomplete CLI templates", () => {
  const error = {
    code: "completion_gate_failed",
    message: "Missing report evidence",
    next: [{ command: "project-ledger work complete --id <id> --report <report>" }],
  };
  expect(projectLedgerNativeNextHints(error, {
    toolName: "project_ledger_work_complete",
    args: { project_ref: "project-a", id: "W-REAL", validation: "passed", review: "reviewed" },
  })).toEqual([expect.objectContaining({
    tool: "project_ledger_show",
    args: { project_ref: "project-a", id: "W-REAL", kind: "work" },
  })]);
  expect(projectLedgerNativeNextHints(error)).toEqual([]);
  expect(projectLedgerNativeNextHints({ code: "invalid_arguments" }, {
    toolName: "project_ledger_show", args: {},
  })).toEqual([]);
  expect(error.message).toBe("Missing report evidence");
});

test("Ledger discovery and index hints retain the original explicit project", () => {
  const context = { toolName: "project_ledger_show", args: { project_ref: "project-a", id: "W-MISSING" } };
  expect(projectLedgerNativeNextHints({ code: "record_not_found" }, context)[0]?.args)
    .toEqual({ project_ref: "project-a", kind: "all" });
  expect(projectLedgerNativeNextHints({ next: ["project-ledger index --project /private/path"] }, context)[0]?.args)
    .toEqual({ project_ref: "project-a" });
});

test("command effect description includes ask-first approval without claiming full-access-only execution", () => {
  const description = runCommandToolDefinition.parameters.properties.state_effect.description;
  expect(description).toContain("ask_first suspends for approval and resumes after approval");
  expect(description).toContain("accepted Plan Review");
  expect(description).not.toContain("require full access");
});
