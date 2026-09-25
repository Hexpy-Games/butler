import { expect, test } from "bun:test";
import { runBtccAgentLoop, type BtccAgentLoopToolDefinition } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import type { ModelRoundRequest, ModelRoundResult } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";

const lookup: BtccAgentLoopToolDefinition = {
  name: "lookup", description: "Look up.",
  parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
};

function bounded(steps: ModelRoundResult[]) {
  const requests: ModelRoundRequest[] = [];
  return {
    requests,
    port: { async runRound(request: ModelRoundRequest) {
      requests.push(structuredClone(request));
      const step = steps[requests.length - 1];
      if (!step) throw new Error(`scripted model exceeded ${steps.length} rounds`);
      return step;
    } },
  };
}

const textCall: ModelRoundResult = { text: 'lookup({"key":"a"})', toolCalls: [], textToolCallNames: ["lookup"] };

test("a text-form tool call stays in history and the model is told it was not executed", async () => {
  const executed: string[] = [];
  const script = bounded([
    textCall,
    textCall,
    { toolCalls: [{ id: "c1", name: "lookup", arguments: { key: "a" }, rawArguments: '{"key":"a"}' }] },
    { text: "Found it.", toolCalls: [] },
  ]);
  const output = await runBtccAgentLoop({
    prompt: "Look up a.", tools: [lookup], modelRound: script.port,
    executeTool: async (call) => { executed.push(call.name); return { value: 1 }; },
  });
  expect(output.finalText).toBe("Found it.");
  expect(executed).toEqual(["lookup"]);
  const second = script.requests[1]!.messages;
  expect(second.some((message) => message.role === "assistant" && message.content.includes('lookup({"key":"a"})'))).toBe(true);
  const feedback = second.at(-1)!;
  expect(feedback.role).toBe("user");
  expect(feedback.content).toContain("lookup");
  expect(feedback.content).toContain("not executed");
  expect(feedback.content).toContain("structured tool-call channel");
  expect(script.requests[2]!.messages.at(-1)!.content).toContain("has been given 2 times");
});

test("a legacy text-call failure becomes an observation instead of a thrown error", async () => {
  const script = bounded([textCall, { text: "Answered directly.", toolCalls: [] }]);
  const output = await runBtccAgentLoop({
    prompt: "Look up a.", tools: [lookup], modelRound: script.port,
    executeTool: async () => ({}),
    onTextToolCalls: () => ({ status: "fail", error: new Error("Local model failed to use the structured tool-call channel") }),
  });
  expect(output.finalText).toBe("Answered directly.");
  expect(script.requests[1]!.messages.at(-1)!.content).toContain("not executed");
});
