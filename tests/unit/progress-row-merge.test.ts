import { expect, test } from "bun:test";
import { dedupeProgressRows } from "../../packages/butler-agent/src/gateways/app/domain/progress-summary/progress-row-merge.ts";
import type { ProgressSummaryRow } from "../../packages/butler-agent/src/gateways/app/interface/protocol/app-protocol.ts";

function row(id: string, overrides: Partial<ProgressSummaryRow> = {}): ProgressSummaryRow {
  return {
    id, kind: "tool", safe_label: "Read file", state: "running",
    created_at: "2026-09-06T00:00:00Z", ...overrides,
  };
}

test("tool history merges by identity without scanning accumulated tool rows", () => {
  let identityReads = 0;
  const count = 2_000;
  const starts = Array.from({ length: count }, (_, index) => Object.defineProperty(
    row(`start-${index}`), "tool_call_id", {
      enumerable: true,
      get() { identityReads += 1; return `call-${index}`; },
    },
  ));
  const completions = starts.map((_, index) => row(`end-${index}`, {
    tool_call_id: `call-${index}`, state: "delivered",
  }));
  const merged = dedupeProgressRows([...starts, ...completions]);
  expect(merged).toHaveLength(count);
  expect(merged.map((item) => item.tool_call_id)).toEqual(completions.map((item) => item.tool_call_id));
  expect(merged.every((item) => item.state === "delivered")).toBe(true);
  expect(identityReads).toBeLessThan(count * 20);
});

test("legacy correlation retains identity, ambiguity and terminal boundaries", () => {
  expect(dedupeProgressRows([
    row("legacy"), row("start", { tool_call_id: "call" }),
    row("end", { tool_call_id: "call", state: "delivered" }),
    row("later-legacy"),
  ])).toHaveLength(1);
  expect(dedupeProgressRows([
    row("legacy-a"), row("legacy-b"), row("start", { tool_call_id: "call" }),
  ])).toHaveLength(3);
  expect(dedupeProgressRows([
    row("terminal", { state: "delivered" }), row("start", { tool_call_id: "call" }),
  ])).toHaveLength(2);
  expect(dedupeProgressRows([
    row("a", { tool_call_id: "a" }), row("b", { tool_call_id: "b" }), row("legacy"),
  ])).toHaveLength(3);
});

test("direct-key replacement removes the previous tool identity from the index", () => {
  const merged = dedupeProgressRows([
    row("event", { kind: "work_block", work_block_id: "work", tool_call_id: "old" }),
    row("event", { kind: "work_block", work_block_id: "work", tool_call_id: "new" }),
    row("old-result", { tool_call_id: "old", state: "delivered" }),
  ]);
  expect(merged.map((item) => item.tool_call_id)).toEqual(["new", "old"]);
});
