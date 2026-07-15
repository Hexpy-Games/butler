import { expect, test } from "bun:test";
import {
  btccCapabilityAllows,
  btccCapabilityManifestForTool,
} from "../../packages/butler-agent/src/agent/turn/btcc/capability-manifest.ts";
import { btccLedgerAuthoringBundle } from "../../packages/butler-agent/src/agent/turn/btcc/ledger-authoring-contracts.ts";
import { updateTodoListToolDefinition } from "../../packages/butler-agent/src/agent/tools/work-tracking/update_todo_list/definition.ts";
import { readFileToolDefinition } from "../../packages/butler-agent/src/agent/tools/file-tools/read_file/definition.ts";
import { writeFileToolDefinition } from "../../packages/butler-agent/src/agent/tools/file-tools/write_file/definition.ts";
import { projectLedgerNativeToolDefinitions } from "../../packages/butler-agent/src/agent/tools/project-ledger/native.ts";

test("BTCC admits tools by declared effect, purpose, scope, and Ledger operation", () => {
  expect(btccCapabilityAllows({
    tool: updateTodoListToolDefinition,
    purpose: "planning",
    effects: ["plan_mutation"],
    scopes: ["task"],
  })).toBe(true);
  expect(btccCapabilityAllows({
    tool: writeFileToolDefinition,
    purpose: "planning",
    effects: ["plan_mutation"],
  })).toBe(false);
  expect(btccCapabilityAllows({
    tool: writeFileToolDefinition,
    purpose: "execution",
    effects: ["workspace_mutation"],
    scopes: ["workspace"],
  })).toBe(true);
  expect(btccCapabilityAllows({
    tool: readFileToolDefinition,
    purpose: "review",
    effects: ["observe"],
    scopes: ["workspace"],
  })).toBe(true);

  const create = requiredLedgerTool("project_ledger_create");
  const check = requiredLedgerTool("project_ledger_check");
  const attemptStart = requiredLedgerTool("project_ledger_attempt_start");
  expect(btccCapabilityAllows({
    tool: create,
    purpose: "planning",
    effects: ["ledger_mutation"],
    scopes: ["project"],
    ledgerOperations: ["mutate"],
    ledgerRecordKinds: ["spec", "plan", "work", "task"],
  })).toBe(true);
  expect(btccCapabilityAllows({
    tool: attemptStart,
    purpose: "execution",
    effects: ["ledger_mutation"],
    scopes: ["project"],
    ledgerOperations: ["mutate"],
    ledgerRecordKinds: ["attempt"],
  })).toBe(true);
  expect(btccCapabilityAllows({
    tool: attemptStart,
    purpose: "planning",
    effects: ["ledger_mutation"],
    scopes: ["project"],
    ledgerRecordKinds: ["task"],
  })).toBe(false);
  expect(btccCapabilityAllows({
    tool: check,
    purpose: "planning",
    effects: ["observe"],
    scopes: ["project"],
    ledgerOperations: ["validate"],
  })).toBe(true);
});

test("undeclared tools cannot enter Planning and default to explicit external Execution effects", () => {
  const undeclared = {
    type: "function" as const,
    name: "connector_future_action",
    description: "Future connector action",
    parameters: { type: "object", properties: {} },
  };
  const manifest = btccCapabilityManifestForTool(undeclared);
  expect(manifest).toMatchObject([{
    effect: "external_mutation",
    purposes: ["execution"],
    scopes: ["external"],
    declared: false,
  }]);
  expect(btccCapabilityAllows({
    tool: undeclared,
    purpose: "planning",
    effects: ["observe", "plan_mutation"],
  })).toBe(false);
});

test("Ledger authoring contracts are complete, ordered, and content-addressed", () => {
  const first = btccLedgerAuthoringBundle();
  const second = btccLedgerAuthoringBundle();
  expect(first.contractHash).toBe(second.contractHash);
  expect(first.dependencyOrder).toEqual(["spec", "plan", "work", "task", "attempt"]);
  expect(first.contracts.map((contract) => contract.recordKind)).toEqual(first.dependencyOrder);
  for (const contract of first.contracts) {
    expect(contract.requiredSections.length).toBeGreaterThanOrEqual(4);
    expect(contract.invariants.length).toBeGreaterThanOrEqual(3);
    expect(contract.completionEvidence.length).toBeGreaterThanOrEqual(3);
  }
});

function requiredLedgerTool(name: string) {
  const tool = projectLedgerNativeToolDefinitions.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing_ledger_tool:${name}`);
  return tool;
}
