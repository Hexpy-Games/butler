import { expect, test } from "bun:test";
import type { FunctionToolDefinition } from "../../packages/butler-agent/src/integrations/providers/provider.ts";
import {
  embeddedWorkBlockCalls,
  validateEmbeddedWorkBlockCall,
  workBlockEnvelope,
  workBlockTool,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/work-block-tool.ts";

test("a one-tool work block uses top-level args instead of a singleton call union", () => {
  const wrapper = workBlockTool([tool("project_ledger_list")]);
  const properties = property(wrapper.parameters, "properties");

  expect(properties.calls).toBeUndefined();
  expect(property(properties, "args")).toEqual({ type: "object", properties: {} });
  expect(wrapper.parameters.required).toEqual(["decision", "args"]);
  expect(embeddedWorkBlockCalls({ args: { kind: "all" } }, [
    tool("project_ledger_list"),
  ])).toEqual([{ name: "project_ledger_list", args: { kind: "all" } }]);
});

test("a multi-tool work block keeps mutually exclusive call schemas", () => {
  const wrapper = workBlockTool([tool("read_file"), tool("run_command")]);
  const calls = property(property(wrapper.parameters, "properties"), "calls");
  const items = property(calls, "items");

  expect(Array.isArray(items.oneOf)).toBe(true);
  expect(items.oneOf).toHaveLength(2);
});

test("a decision may omit redundant expected_effect without a repair request", () => {
  const decision = {
    block_title: "Read capture sources",
    objective: "Read the capture sources needed for the implementation.",
    rationale: "The current API must be known before editing it.",
    next_step: "Use the observed signatures to implement the focused change.",
  };
  const wrapper = workBlockTool([tool("read_file")]);
  const decisionSchema = property(property(wrapper.parameters, "properties"), "decision");

  expect(decisionSchema.required).not.toContain("expected_effect");
  expect(workBlockEnvelope({ decision, args: { path: "src/a.ts" } })).toMatchObject({
    blockTitle: "Read capture sources",
    expectedEffect: decision.next_step,
  });
});

test("an overlong provider title is bounded without replacing the authored decision", () => {
  const title = `Inspect capture implementation ${"details ".repeat(20)}`;
  const envelope = workBlockEnvelope({
    decision: {
      block_title: title,
      objective: "Inspect the capture implementation before applying a focused repair.",
      rationale: "The failing behavior must be tied to the current source.",
      next_step: "Apply the smallest source change and run the focused validation.",
    },
    args: { path: "src/capture.ts" },
  });

  expect(envelope?.blockTitle.length).toBeLessThanOrEqual(96);
  expect(envelope?.blockTitle).toEndWith("...");
  expect(envelope?.summary).toContain("Inspect the capture implementation");
});

test("embedded calls are validated against the exact projected frontier schema", () => {
  const projected = tool("project_ledger_create", {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", const: "task" },
      work_id: { type: "string" },
      status: { type: "string", enum: ["todo", "in_progress"] },
    },
    required: ["kind", "work_id"],
  });
  expect(validateEmbeddedWorkBlockCall({
    name: "project_ledger_create",
    args: { kind: "task", work_id: "W-1", status: "todo" },
  }, [projected])).toEqual({ ok: true });
  expect(validateEmbeddedWorkBlockCall({
    name: "project_ledger_create",
    args: { kind: "work", status: "active" },
  }, [projected])).toMatchObject({ ok: false });
});

function tool(
  name: string,
  parameters: Record<string, unknown> = { type: "object", properties: {} },
): FunctionToolDefinition {
  return {
    type: "function",
    name,
    description: name,
    parameters,
  };
}

function property(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`missing object property: ${key}`);
  }
  return value as Record<string, unknown>;
}
