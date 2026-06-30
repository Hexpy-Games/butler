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
  expect(repeatedToolFamilyKey("run_command", { command: "git diff -- packages/butler-agent" })).toBe("command:git-diff");
  expect(isStateMutatingToolCall("web_search", { query: "Butler" })).toBe(false);
  expect(isStateMutatingToolCall("run_command", { command: "project-ledger render dashboard --write" })).toBe(true);
});
