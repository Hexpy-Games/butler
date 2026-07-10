import { expect, test } from "bun:test";
import {
  isStateMutatingToolCall,
  repeatedToolFamilyKey,
  ToolStagnationObserver,
} from "../../packages/butler-agent/src/agent/turn/tool-loop-guards.ts";

test("tool stagnation is advisory only after the executed result and state revision repeat", () => {
  const observer = new ToolStagnationObserver();
  const args = { command: "bun test tests/unit/native-tool-loop-runtime.test.ts" };

  expect(observer.observe({
    name: "run_command",
    args,
    resultFingerprint: "result-a",
    stateRevision: "revision-a",
    mutated: false,
  })).toEqual({
    family: "command:test",
    count: 1,
    stagnant: false,
  });
  expect(observer.observe({
    name: "run_command",
    args,
    resultFingerprint: "result-a",
    stateRevision: "revision-a",
    mutated: false,
  })).toEqual({
    family: "command:test",
    count: 2,
    stagnant: true,
  });
  expect(observer.observe({
    name: "run_command",
    args,
    resultFingerprint: "result-b",
    stateRevision: "revision-b",
    mutated: false,
  })).toEqual({
    family: "command:test",
    count: 1,
    stagnant: false,
  });
});

test("tool stagnation history resets after a state mutation", () => {
  const observer = new ToolStagnationObserver();
  const testArgs = { command: "bun test tests/unit/native-tool-loop-runtime.test.ts" };

  observer.observe({
    name: "run_command",
    args: testArgs,
    resultFingerprint: "result-a",
    stateRevision: "revision-a",
    mutated: false,
  });
  expect(observer.observe({
    name: "write_file",
    args: { path: "result.txt", content: "changed" },
    resultFingerprint: "mutation-result",
    stateRevision: "revision-b",
    mutated: true,
  })).toBeNull();
  expect(observer.observe({
    name: "run_command",
    args: testArgs,
    resultFingerprint: "result-a",
    stateRevision: "revision-a",
    mutated: false,
  })).toEqual({
    family: "command:test",
    count: 1,
    stagnant: false,
  });
});

test("repeated tool family helpers classify read-only and state-mutating calls", () => {
  expect(repeatedToolFamilyKey("grep_files", {
    pattern: "promptCacheKey",
    include_globs: ["packages/**/*.ts"],
  })).toBe("workspace-grep:promptCacheKey");
  expect(repeatedToolFamilyKey("grep_files", {
    pattern: "promptCacheKey",
    include_globs: ["tests/**/*.ts"],
    regex: true,
  })).toBe("workspace-grep:promptCacheKey");
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
