import { expect, test } from "bun:test";
import {
  appendButlerToolInstructions,
  appendRoleToolPolicyInstructions,
} from "../../packages/butler-agent/src/agent/turn/native/output/tool-instructions.ts";

test("native tool instructions preserve capability-selection and recovery guidance", () => {
  const instructions = appendButlerToolInstructions("Base system prompt.");

  expect(instructions).toStartWith("Base system prompt.");
  expect(instructions).toContain("## Native Butler Tools");
  expect(instructions).toContain("Do not ask the user to name the tool");
  expect(instructions).toContain("do not rely on request-word shortcuts or hardcoded workflow shortcuts");
  expect(instructions).toContain("Do not declare failure from a single weak or inconclusive search");
  expect(instructions).toContain("Project Ledger records are not ordinary Markdown targets");
  expect(instructions).toContain("Use Project Ledger tools or `project-ledger` commands");
  expect(instructions).toContain("shell redirection, heredocs, and ad hoc scripts are not accepted paths");
});

test("fixed tool instructions advertise only the compiled surface", () => {
  const instructions = appendButlerToolInstructions("Persona prompt.", {
    fixedSurface: true,
    availableToolNames: ["grep_files", "read_file"],
  });

  expect(instructions).toContain("## Fixed Butler Tool Surface");
  expect(instructions).toContain("`grep_files`, `read_file`");
  expect(instructions).toContain("literal unless `regex=true`");
  expect(instructions).toContain("function names");
  expect(instructions).toContain("assignments over UI copy");
  expect(instructions).not.toContain("`run_command`");
  expect(instructions).not.toContain("`tool_search`");
  expect(instructions).not.toContain("## Native Butler Tools");
});

test("role tool policy instructions append worker and steward boundaries only for those roles", () => {
  const workerInstructions = appendRoleToolPolicyInstructions("worker", "Base.");
  const stewardInstructions = appendRoleToolPolicyInstructions("steward", "Base.");
  const butlerInstructions = appendRoleToolPolicyInstructions("butler", "Base.");

  expect(workerInstructions).toContain("## Worker Role Policy");
  expect(workerInstructions).toContain("You must not spawn or orchestrate child work");
  expect(stewardInstructions).toContain("## Steward Role Policy");
  expect(stewardInstructions).toContain("internal project/workstream custodian");
  expect(butlerInstructions).toBe("Base.");
});
