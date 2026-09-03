import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBtccAgentLoop } from "../../packages/butler-agent/src/agent/btcc/agent-loop/agent-loop.ts";
import { prepareBoundedModelContext } from "../../packages/butler-agent/src/agent/btcc/agent-loop/bounded-turn-context.ts";
import { withStewardDirection } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-steward-direction.ts";
import { runOpenAIModelRound } from "../../packages/butler-agent/src/integrations/providers/openai/model-round.ts";
import { createProviderModelRoundPort } from "../../packages/butler-agent/src/integrations/providers/runtime.ts";
import { registerHostedModelConfig } from "../../packages/butler-agent/src/integrations/providers/shared/registered-models.ts";
import { budgetToolOutput, readToolOutputArtifact } from "../../packages/butler-agent/src/agent/context/tool-output-budgeter.ts";
import type { ModelRoundMessage, ModelRoundRequest } from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";

const roots: string[] = [];
const originalFetch = globalThis.fetch;
const priorBase = process.env.OPENAI_BASE_URL;
const priorData = process.env.BUTLER_DATA;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (priorBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = priorBase;
  if (priorData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = priorData;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("normal no-budget selection applies its default without phase-proof dependencies or forced completion", async () => {
  const messages: ModelRoundMessage[] = [{ role: "user", content: "accepted assignment", continuationItemId: "turn-item-0" }];
  for (let index = 1; index <= 4; index += 1) messages.push({
    role: "assistant", content: `old-${index}-${"x".repeat(80_000)}`, continuationItemId: `turn-item-${index}`,
  });
  const projected = await prepareBoundedModelContext({ messages, tools: [], roundId: "round", responseItemId: "turn-item-5" });
  expect(projected.requiresRebase).toBe(true);
  expect(projected.envelope?.modelFacingBytes).toBeLessThanOrEqual(192 * 1024);
  expect(projected.envelope?.admitProviderBody).toBeUndefined();
  expect(projected.messages[0]?.content).toBe("accepted assignment");
  expect(projected.messages.at(-1)?.content).toContain("old-4-");
});

test("no-budget real loop sends bounded OpenAI bodies retaining Plan, checkpoint, steering and saved output refs", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker-normal-context-"));
  roots.push(root);
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  const bodies: Array<Record<string, any>> = [];
  const requests: ModelRoundRequest[] = [];
  const saved = budgetToolOutput({
    butlerData: root, command: "inspection", outputMode: "full", maxModelTokens: 2_000,
    result: { stdout: "OMITTED_ORIGINAL_OUTPUT ".repeat(4_000), stderr: "", exit_code: 0, timed_out: false },
  });
  const tools = ["replace_work_plan", "record_work_checkpoint", "run_command"].map((name) => ({
    name, description: name, parameters: { type: "object", properties: { description: { type: "string" } }, required: [] },
  }));
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const index = bodies.length - 1;
    const name = index === 0 ? "replace_work_plan" : index === 1 ? "record_work_checkpoint" : "run_command";
    return Response.json({ id: `response-${index}`, model: "gpt-5.6-sol", output: index < 6 ? [{
      type: "function_call", call_id: `call-${index}`, name,
      arguments: JSON.stringify({ description: index === 0 ? "ACCEPTED_PLAN_ACTION" : "inspect" }),
    }] : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "model chose to finish" }] }] });
  }) as typeof fetch;
  let directionReads = 0;
  let reviews = 0;
  const direction = withStewardDirection({
    modelRound: { runRound: async (request) => {
      requests.push(request);
      expect(request.boundedContinuation?.admitProviderBody).toBeUndefined();
      return await runOpenAIModelRound(request, { authorization: "Bearer test", mode: "api_key" });
    } },
    safeBoundary: async () => ++directionReads === 8 ? "LATEST_USER_STEERING" : undefined,
    reviewFinalCandidate: () => ++reviews === 1
      ? { status: "continue", observation: "RUNTIME_REVIEW_OBSERVATION" }
      : { status: "accepted" },
    afterToolBatch: () => "continue",
  });
  const result = await runBtccAgentLoop({
    prompt: "ACCEPTED_ASSIGNMENT", instructions: "STABLE_INSTRUCTION_PREFIX", model: "openai/gpt-5.6-sol",
    butlerData: root, maxModelFacingBytes: 22_000, tools,
    ...direction,
    executeTool: async (call) => call.name === "run_command"
      ? saved
      : { ok: true, checkpoint: call.name === "record_work_checkpoint" ? "CURRENT_WORK_CHECKPOINT" : "plan accepted" },
  });
  expect(result.finalText).toBe("model chose to finish");
  expect(bodies).toHaveLength(9);
  const last = bodies.at(-1)!;
  expect(last).not.toHaveProperty("previous_response_id");
  expect(last.instructions).toBe("STABLE_INSTRUCTION_PREFIX");
  const text = JSON.stringify(last.input);
  expect(text).toContain("ACCEPTED_ASSIGNMENT");
  expect(text).toContain("ACCEPTED_PLAN_ACTION");
  expect(text).toContain("CURRENT_WORK_CHECKPOINT");
  expect(text).toContain("LATEST_USER_STEERING");
  expect(text).toContain("RUNTIME_REVIEW_OBSERVATION");
  expect(text).toContain("read_tool_output_artifact");
  expect(text).toContain(saved.butler_tool_artifact!.id);
  expect(Buffer.byteLength(JSON.stringify(last))).toBeLessThan(22_000);
  expect(JSON.stringify(readToolOutputArtifact(saved.butler_tool_artifact!.path))).toContain("OMITTED_ORIGINAL_OUTPUT");
  expect(requests.at(-1)!.messages.length).toBeLessThanOrEqual(result.messages.length);
  expect(result.messages.filter((message) => message.content === "LATEST_USER_STEERING")).toHaveLength(1);
  expect(result.messages.find((message) => message.content === "LATEST_USER_STEERING")?.requestSegmentKind).toBe("current_user_request");
  expect(bodies[1]?.previous_response_id).toBe("response-0");
});

test("normal bounded context reaches the existing non-OpenAI serializer", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker-normal-google-"));
  roots.push(root);
  process.env.BUTLER_DATA = root;
  registerHostedModelConfig({ providerId: "google", modelId: "gemini-3.6-flash", authType: "api_key", apiKey: "test" }, root);
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ candidates: [{ content: { parts: [{ text: "google final" }] } }] });
  }) as typeof fetch;
  const result = await runBtccAgentLoop({
    prompt: "NON_OPENAI_ASSIGNMENT", instructions: "stable", tools: [], model: "google/gemini-3.6-flash", butlerData: root,
    modelRound: createProviderModelRoundPort(), executeTool: async () => { throw new Error("unexpected tool"); },
  });
  expect(result.finalText).toBe("google final");
  expect(JSON.stringify(body.contents)).toContain("NON_OPENAI_ASSIGNMENT");
});

test("tool-free final synthesis sends restored history after an earlier OpenAI rebase", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker-context-final-"));
  roots.push(root);
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  const bodies: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const index = bodies.length - 1;
    return Response.json({ id: `final-response-${index}`, model: "gpt-5.6-sol", output: index < 3 ? [{
      type: "function_call", call_id: `inspect-${index}`, name: "inspect", arguments: "{}",
    }] : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: index === 3 ? "candidate" : "final" }] }] });
  }) as typeof fetch;
  const result = await runBtccAgentLoop({
    prompt: "assignment", model: "openai/gpt-5.6-sol", butlerData: root, maxModelFacingBytes: 6_000,
    tools: [{ name: "inspect", description: "tool instruction ".repeat(200), parameters: { type: "object", properties: {} } }],
    modelRound: { runRound: (request) => runOpenAIModelRound(request, { authorization: "Bearer test", mode: "api_key" }) },
    executeTool: async (call) => ({ fact: `${call.id}:${"x".repeat(900)}` }),
    finalSynthesis: { instructions: "Report the known facts", triggerAfterToolCandidate: true },
  });
  expect(result.finalText).toBe("final");
  expect(bodies).toHaveLength(5);
  expect(bodies[3]).not.toHaveProperty("previous_response_id");
  expect(JSON.stringify(bodies[3]?.input)).not.toContain("inspect-0");
  const final = bodies[4]!;
  expect(final).not.toHaveProperty("tools");
  expect(final).not.toHaveProperty("previous_response_id");
  expect(JSON.stringify(final.input)).toContain("inspect-0");
  expect(JSON.stringify(final.input)).toContain("inspect-2");
});
