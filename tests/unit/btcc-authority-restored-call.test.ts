import { expect, test } from "bun:test";
import { runBtccAgentLoop } from "../../packages/butler-agent/src/agent/btcc/agent-loop/agent-loop.ts";
import type { BtccAgentLoopInput } from "../../packages/butler-agent/src/agent/btcc/agent-loop/contracts.ts";

const calls = ["read-first", "pending-edit", "next-edit"].map((id) => ({
  id, name: "tool_call",
  arguments: { id: "native:edit_file", arguments: { path: id, old_text: "one", new_text: "two" } },
  rawArguments: JSON.stringify({ id: "native:edit_file", arguments: { path: id, old_text: "one", new_text: "two" } }),
}));
const tool = {
  name: "tool_call", description: "Invoke a described tool",
  parameters: { type: "object", properties: { id: { type: "string" }, arguments: { type: "object" } }, required: ["id", "arguments"] },
};

async function suspendBatch() {
  const executed: string[] = [];
  const input: BtccAgentLoopInput = {
    prompt: "Original request, not a synthetic approval message.",
    instructions: "Stable instructions.",
    tools: [tool],
    resolveOperationResultCallId: (id) => "journal-" + id,
    executeTool: async (call) => {
      executed.push(call.id);
      return call.id === "pending-edit"
        ? { ok: true, authority_pending: true, request_ref: "permission-request" }
        : { ok: true, actual: "read-result" };
    },
    modelRound: { async runRound() {
      return { text: "I will edit these files.", toolCalls: calls, continuation: { responseId: "accepted-response" } };
    } },
  };
  const pending = await runBtccAgentLoop(input);
  expect(pending.suspension).toBe("authority_pending");
  expect(pending.finalText).toBe("");
  expect(executed).toEqual(["read-first", "pending-edit"]);
  expect(pending.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(["read-first"]);
  expect(JSON.stringify(pending.messages)).not.toContain("authority_pending");
  expect(pending.events.filter((event) => event.type === "tool_result")).toHaveLength(1);
  // Exercise the durable serialization boundary, not a live Promise closure.
  const cursor: NonNullable<typeof pending.authorityContinuation> = JSON.parse(JSON.stringify(pending.authorityContinuation));
  expect(cursor.callId).toBe("journal-pending-edit");
  expect(cursor.batch.nextCallIndex).toBe(1);
  expect(cursor.batch.calls).toEqual(calls);
  return { input, cursor };
}

test("Allow resumes the original call and remaining accepted batch before the next model round", async () => {
  const { input, cursor } = await suspendBatch();
  const executed: string[] = [];
  let rounds = 0;
  const result = await runBtccAgentLoop({
    ...input,
    prompt: "This replacement prompt must not replace original context.",
    instructions: "This replacement prefix must not be used.",
    authorityContinuation: cursor, authorityDecision: { action: "allow" },
    executeTool: async (call) => {
      executed.push(call.id);
      expect(call.arguments).toEqual(calls.find((candidate) => candidate.id === call.id)!.arguments);
      return { ok: true, actual: call.id };
    },
    modelRound: { async runRound(request) {
      rounds++;
      expect(executed).toEqual(["pending-edit", "next-edit"]);
      expect(request.roundId).toBe("btcc-model-round-1");
      expect(request.instructions).toBe("Stable instructions.");
      expect(request.continuation).toEqual({ responseId: "accepted-response" });
      expect(request.messages[0]?.content).toBe(input.prompt);
      expect(request.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
      expect(request.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(calls.map((call) => call.id));
      return { text: "Both edits are complete.", toolCalls: [] };
    } },
  });
  expect(result.finalText).toBe("Both edits are complete.");
  expect(rounds).toBe(1);
});

for (const action of ["deny", "modify"] as const) {
  test(action + " does not execute the old call or its unstarted siblings", async () => {
    const { input, cursor } = await suspendBatch();
    const unexecuted: string[] = [];
    const result = await runBtccAgentLoop({
      ...input, authorityContinuation: cursor,
      authorityDecision: action === "modify" ? { action, input: "Keep the file; use a different location." } : { action },
      onUnexecutedToolCall: async (call) => { await Promise.resolve(); unexecuted.push(call.id); },
      executeTool: async () => { throw new Error("No old effect may execute"); },
      modelRound: { async runRound(request) {
        expect(unexecuted).toEqual(["pending-edit", "next-edit"]);
        const results = request.messages.filter((message) => message.role === "tool");
        expect(results.map((message) => message.toolCallId)).toEqual(calls.map((call) => call.id));
        expect(results[0]?.content).toContain("read-result");
        expect(results[1]?.content).toContain(action === "deny" ? "authority_request_denied" : "authority_request_modified");
        expect(results[2]?.content).toContain("tool_batch_not_executed");
        if (action === "modify") expect(request.messages.at(-1)?.content).toBe("Keep the file; use a different location.");
        return { text: "I will follow your decision.", toolCalls: [] };
      } },
    });
    expect(result.finalText).toBe("I will follow your decision.");
  });
}
