import { expect, test } from "bun:test";
import type { FunctionToolDefinition } from "../../packages/butler-agent/src/integrations/providers/provider.ts";
import type { CompiledTurnContract } from "../../packages/butler-agent/src/agent/turn/turn-contract-types.ts";
import {
  createObligationToolSurfaceController,
  createObligationToolSurfaceSession,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/obligation-tool-surface.ts";

const tools = [
  "project_ledger_list",
  "project_ledger_create",
  "project_ledger_check",
  "update_todo_list",
  "update_work_stream_state",
  "query_project_work",
  "inspect_project_status",
  "read_tool_evidence_artifact",
  "read_file",
  "write_file",
  "run_command",
].map((name): FunctionToolDefinition => ({
  type: "function",
  name,
  description: name,
  parameters: { type: "object", properties: {} },
}));

test("mixed ledger-first contracts expose the next obligation producer instead of workspace exploration", () => {
  const controller = createObligationToolSurfaceController(contract());
  expect(controller.project(tools).map((tool) => tool.name)).not.toContain("update_work_stream_state");
  expect(controller.project(tools).map((tool) => tool.name)).toEqual([
    "project_ledger_list",
  ]);
  expect(controller.project(tools)[0]?.description).toContain("bounded discovery step");
  expect((controller.project(tools)[0]?.parameters.properties as any).kind.const).toBe("all");
  expect(controller.project(tools)[0]?.parameters.required).toEqual(["kind"]);
  controller.observe({
    name: "project_ledger_list",
    args: { kind: "all", query: "web.capture" },
    result: { ok: true, data: { records: [] } },
  });
  expect(controller.state()).toMatchObject({ ledgerDiscoveryObserved: true });
  expect(controller.project(tools).map((tool) => tool.name)).toEqual([
    "project_ledger_create",
    "update_todo_list",
  ]);
  expect(controller.project(tools).map((tool) => tool.name)).not.toContain("project_ledger_show");

  let create = controller.project(tools).find((tool) => tool.name === "project_ledger_create")!;
  expect(oneOfBranches(create).map((branch: any) => branch.properties.kind.const)).toEqual([
    "spec", "work", "task",
  ]);
  expect(create.description).toContain("later calls in the same block reference the earlier chosen spec or work id");

  for (const kind of ["spec", "work", "task"] as const) {
    controller.observe({
      name: "project_ledger_create",
      args: { kind, id: `TEST-${kind}` },
      result: { ok: true },
    });
    const remaining = kind === "spec" ? ["work", "task"] : kind === "work" ? ["task"] : [];
    create = controller.project(tools).find((tool) => tool.name === "project_ledger_create")!;
    if (remaining.length > 0) {
      expect(oneOfBranches(create).map((branch: any) => branch.properties.kind.const)).toEqual(remaining);
      const nextBranch = oneOfBranches(create)[0] as any;
      expect(nextBranch.required).toContain("spec");
      expect(nextBranch.required).toContain("acceptance");
      if (remaining[0] === "task") expect(nextBranch.required).toContain("work_id");
      expect(create.parameters.properties).not.toHaveProperty("status");
      expect(create.description).toContain("Omit status");
    } else {
      expect(create).toBeUndefined();
    }
  }
  expect(controller.state()).toMatchObject({ gated: true, ledgerCheckPassed: false });
  expect(controller.project(tools).map((tool) => tool.name)).toEqual([
    "project_ledger_check",
    "update_todo_list",
  ]);
  expect(controller.project(tools).map((tool) => tool.name)).not.toContain("project_ledger_create");
  controller.observe({ name: "project_ledger_check", args: {}, result: { ok: true } });

  expect(controller.state()).toMatchObject({
    gated: false,
    ledgerCheckPassed: true,
    observedLedgerKinds: ["spec", "task", "work"],
    stage: "workspace_execution",
  });
  expect(controller.project(tools).map((tool) => tool.name)).toEqual([
    "project_ledger_check",
    "update_todo_list",
    "read_tool_evidence_artifact",
    "read_file",
    "write_file",
    "run_command",
  ]);
  expect(controller.project(tools).map((tool) => tool.name)).not.toContain("project_ledger_create");
});

test("a ledger check must follow the latest required mutation", () => {
  const controller = createObligationToolSurfaceController(contract());
  controller.observe({ name: "project_ledger_check", args: {}, result: { ok: true } });
  for (const kind of ["spec", "work", "task"] as const) {
    controller.observe({
      name: "project_ledger_create",
      args: { kind },
      result: { ok: true },
    });
  }
  expect(controller.state()).toMatchObject({
    gated: true,
    ledgerCheckPassed: false,
    stage: "ledger",
  });
});

test("Ledger show is exposed only when bounded discovery returned a candidate", () => {
  const candidateTools = [
    ...tools,
    { type: "function", name: "project_ledger_show", description: "show", parameters: { type: "object", properties: {} } },
  ] satisfies FunctionToolDefinition[];
  const controller = createObligationToolSurfaceController(contract());
  controller.observe({
    name: "project_ledger_list",
    args: { kind: "all" },
    result: { ok: true, data: { results: [{ id: "SPEC-WEB-CAPTURE", kind: "spec" }] } },
  });
  expect(controller.state()).toMatchObject({ ledgerDiscoveryCandidateCount: 1 });
  expect(controller.project(candidateTools).map((tool) => tool.name)).toContain("project_ledger_show");
});

test("todo progress cannot satisfy workspace mutation and a completion gap focuses structured validation", () => {
  const controller = createObligationToolSurfaceController(contract());
  for (const kind of ["spec", "work", "task"] as const) {
    controller.observe({ name: "project_ledger_create", args: { kind }, result: { ok: true } });
  }
  controller.observe({ name: "update_todo_list", args: { todos: [] }, result: { ok: true } });
  controller.observe({ name: "project_ledger_check", args: {}, result: { ok: true } });
  expect(controller.state()).toMatchObject({ stage: "workspace_execution", workspaceMutationObserved: false });

  controller.observe({ name: "write_file", args: { path: "src/a.ts" }, result: { ok: true } });
  expect(controller.state()).toMatchObject({ stage: "workspace_execution" });
  controller.focusMissingDeliverables(["validation"]);
  expect(controller.state()).toMatchObject({ stage: "workspace_validation", validationFocused: true });
  const projected = controller.project(tools);
  expect(projected.map((tool) => tool.name)).toEqual(["run_command"]);
  expect(projected[0]?.parameters.required).toEqual(["validation_suite"]);
});

test("failed validation opens repair and a passing retry restores workspace execution", () => {
  const controller = createObligationToolSurfaceController(contract(), {
    observedLedgerKinds: ["spec", "work", "task"],
    ledgerCheckPassed: true,
    workspaceMutationObserved: true,
    validationFocused: true,
  });
  controller.observe({
    name: "run_command",
    args: { command: "bun test", validation_suite: "unit" },
    result: validationResult(false),
  });
  expect(controller.state()).toMatchObject({ stage: "workspace_repair", validationFailed: true });
  expect(controller.project(tools).map((tool) => tool.name)).toContain("write_file");

  controller.observe({ name: "write_file", args: { path: "src/fix.ts" }, result: { ok: true } });
  expect(controller.state()).toMatchObject({ stage: "workspace_validation", validationFailed: false });
  controller.observe({
    name: "run_command",
    args: { command: "bun test", validation_suite: "unit" },
    result: validationResult(true),
  });
  expect(controller.state()).toMatchObject({
    stage: "workspace_execution",
    validationObserved: true,
    validationFocused: false,
  });
  expect(controller.project(tools).map((tool) => tool.name)).toContain("write_file");
});

test("one surface session preserves the frontier across prompt phases for the same contract", () => {
  const session = createObligationToolSurfaceSession();
  const first = session.controllerFor(contract());
  first.observe({ name: "project_ledger_create", args: { kind: "spec" }, result: { ok: true } });
  const nextGeneration = { ...contract(), generation: 9 };
  const second = session.controllerFor(nextGeneration);
  expect(second).toBe(first);
  expect(second.state().observedLedgerKinds).toEqual(["spec"]);
});

test("failed mutations and checks cannot promote the workspace surface", () => {
  const controller = createObligationToolSurfaceController(contract());
  controller.observe({
    name: "project_ledger_create",
    args: { kind: "spec" },
    result: { ok: false },
  });
  controller.observe({ name: "project_ledger_check", args: {}, result: { ok: false } });
  expect(controller.state()).toMatchObject({
    gated: true,
    ledgerCheckPassed: false,
    ledgerDiscoveryObserved: false,
    observedLedgerKinds: [],
  });
});

function contract(): CompiledTurnContract {
  const obligations = [
    ["ledger_spec", "project_ledger"],
    ["ledger_work", "project_ledger"],
    ["ledger_tasks", "project_ledger"],
    ["code_change", "workspace"],
    ["validation", "validation"],
  ] as const;
  return {
    schema_version: "butler.compiled-turn-contract.v1",
    contract_id: "contract-test",
    decision_id: "decision-test",
    decision_semantic_fingerprint: "fingerprint",
    action: "start_work",
    target_project_id: "butler",
    target_workstream_id: "work-test",
    deliverables: obligations.map(([deliverable]) => deliverable),
    required_evidence: obligations.map(([deliverable, producer], index) => ({
      deliverable,
      target_kind: producer === "project_ledger" ? "project" : "workspace",
      target_id: "butler",
      generation: 1,
      cardinality: 1,
      expected_item_ids: [],
      evidence_class: producer === "project_ledger" ? "canonical_record" : "durable_diff",
      allowed_producers: [producer],
      obligation_id: `obligation-${index}`,
    })),
    tracking_mode: "ledger",
    closeout_strategy: "ledger",
    terminal_rule: "deliverables_satisfied",
    state: "executing",
    generation: 1,
    evidence_receipt_ids: [],
    continuation_commit_ids: [],
    terminal_delivery_keys: [],
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
  };
}

function validationResult(passed: boolean) {
  return {
    ok: passed,
    evidence_capability_receipts: [{
      capability: "validation_passed",
      maturity: passed ? "verified" : "rejected",
      verified: passed,
    }],
  };
}

function oneOfBranches(tool: FunctionToolDefinition): Record<string, any>[] {
  const value = tool.parameters.oneOf;
  if (!Array.isArray(value)) throw new Error("expected oneOf branches");
  return value as Record<string, any>[];
}
