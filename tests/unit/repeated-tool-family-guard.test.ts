import { expect, test } from "bun:test";
import {
  isStateMutatingToolCall,
  repeatedToolFamilyKey,
  RepeatedToolFamilyGuard,
  REPEATED_TOOL_FAMILY_LIMIT,
} from "../../packages/butler-agent/src/agent/turn/tool-loop-guards.ts";

test("repeated tool family guard blocks only after the configured repeated family limit", () => {
  const guard = new RepeatedToolFamilyGuard();
  const args = { command: "bun test tests/unit/native-tool-loop-runtime.test.ts" };

  for (let i = 1; i <= REPEATED_TOOL_FAMILY_LIMIT; i += 1) {
    expect(guard.record("run_command", args)).toEqual({
      family: "command:test",
      count: i,
      blocked: false,
    });
  }

  expect(guard.record("run_command", args)).toEqual({
    family: "command:test",
    count: REPEATED_TOOL_FAMILY_LIMIT + 1,
    blocked: true,
  });
});

test("repeated tool family guard allows a six-call direct validation burst", () => {
  const guard = new RepeatedToolFamilyGuard();
  const args = { command: "bun test tests/unit/native-tool-loop-runtime.test.ts" };

  for (let i = 1; i <= 6; i += 1) {
    expect(guard.record("run_command", args)?.blocked).toBe(false);
  }
});

test("repeated tool family guard resets after a state-mutating tool call", () => {
  const guard = new RepeatedToolFamilyGuard(1);
  const testArgs = { command: "bun test tests/unit/native-tool-loop-runtime.test.ts" };

  expect(guard.record("run_command", testArgs)?.blocked).toBe(false);
  expect(guard.record("run_command", testArgs)?.blocked).toBe(true);

  guard.resetAfterStateMutation("run_command", {
    command: "printf 'changed' > packages/butler-agent/src/__budget-reset-test.txt",
  });

  expect(guard.record("run_command", testArgs)).toEqual({
    family: "command:test",
    count: 1,
    blocked: false,
  });
});

test("repeated tool family helpers classify read-only and state-mutating calls", () => {
  expect(repeatedToolFamilyKey("inspect_project_status", {})).toBe("project-ledger:status");
  expect(repeatedToolFamilyKey("project_ledger_status", {})).toBe("project-ledger:status");
  expect(repeatedToolFamilyKey("project_ledger_check", {})).toBe("project-ledger:check");
  expect(repeatedToolFamilyKey("project_ledger_create", { kind: "task", id: "T-LEDGER" })).toBe("project-ledger:lifecycle:create:task:T-LEDGER");
  expect(repeatedToolFamilyKey("project_ledger_update", { kind: "work", id: "W-LEDGER" })).toBe("project-ledger:lifecycle:update:work:W-LEDGER");
  expect(repeatedToolFamilyKey("project_ledger_task_update", { id: "T-LEDGER" })).toBe("project-ledger:lifecycle:task:update:T-LEDGER");
  expect(repeatedToolFamilyKey("project_ledger_work_complete", { id: "W-LEDGER" })).toBe("project-ledger:lifecycle:work:complete:W-LEDGER");
  expect(repeatedToolFamilyKey("project_ledger_attempt_start", { task_id: "T-LEDGER" })).toBe("project-ledger:lifecycle:attempt:start:T-LEDGER");
  expect(repeatedToolFamilyKey("project_ledger_attempt_succeed", { id: "A-LEDGER" })).toBe("project-ledger:lifecycle:attempt:succeed:A-LEDGER");
  expect(repeatedToolFamilyKey("project_ledger_attempt_fail", { id: "A-LEDGER" })).toBe("project-ledger:lifecycle:attempt:fail:A-LEDGER");
  expect(repeatedToolFamilyKey("project_ledger_render", { view: "handoff", write: true })).toBe("project-ledger:render:handoff");
  expect(repeatedToolFamilyKey("tool_search", { provider: "native", category: "workspace", query: "run command" })).toBe("tool-search:native:workspace:any:run command");
  expect(repeatedToolFamilyKey("list_tool_capabilities", { category: "workspace" })).toBe("tool-capabilities:any:workspace:any:any");
  expect(repeatedToolFamilyKey("run_command", { command: "git diff -- packages/butler-agent" })).toBe("command:git-diff");
  expect(isStateMutatingToolCall("web_search", { query: "Butler" })).toBe(false);
  expect(isStateMutatingToolCall("project_ledger_check", {})).toBe(false);
  expect(isStateMutatingToolCall("project_ledger_render", { view: "dashboard" })).toBe(false);
  expect(isStateMutatingToolCall("project_ledger_render", { view: "dashboard", write: true })).toBe(true);
  expect(isStateMutatingToolCall("run_command", { command: "project-ledger render dashboard --write" })).toBe(true);
});
