import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type { BtccRunCommand } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type { DurableWorkView } from
  "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import { createTurnRuntime as createGuidedTurnRuntime } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import {
  digest,
  stableJson,
} from "../../packages/butler-agent/src/agent/btcc/identity/index.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { createProductionGuidedTurnAgent } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import type {
  ModelRoundMessage,
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
} from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import {
  guidedOperationalFallback,
  guidedOperationalReportPrompt,
  runGuidedAgentLoopWithOperationalReport,
} from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-operational-report.ts";
import { createGuidedToolCallExecutor } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-call-execution.ts";
import { guidedToolOccurrence } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-occurrence.ts";
import { createToolCallToolHandler } from
  "../../packages/butler-agent/src/agent/tools/tool-bridge/tool_call/executor.ts";
import { runCommandToolDefinition } from
  "../../packages/butler-agent/src/agent/tools/run-command/run_command/definition.ts";
import type { ContextualButlerToolExecutor } from
  "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { createGuidedActivityProjection } from
  "../../packages/butler-agent/src/agent/btcc/projection/index.ts";
import { authorizedToolDefinitions, isReplaySafeTool } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-policy.ts";
import { upsertMcpServer } from
  "../../packages/butler-agent/src/interfaces/mcp-client/registry.ts";
import { ModelProviderRequestError } from
  "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import { buildModelRoute } from
  "../../packages/butler-agent/src/agent/btcc/model-route/index.ts";
import { runOpenAIModelRound } from
  "../../packages/butler-agent/src/integrations/providers/openai/model-round.ts";

type ScriptedModelRoundStep =
  | ModelRoundResult
  | ((request: ModelRoundRequest, index: number) =>
    ModelRoundResult | Promise<ModelRoundResult>);

function scriptedModelRound(
  steps: readonly ScriptedModelRoundStep[],
): ModelRoundPort {
  let index = 0;
  return {
    async runRound(request) {
      const step = steps[index];
      const currentIndex = index;
      index += 1;
      if (!step) throw new Error("scripted_model_round_exhausted");
      return typeof step === "function"
        ? await step(request, currentIndex)
        : step;
    },
  };
}

function toolCall(
  id: string,
  name: string,
  arguments_: Record<string, unknown>,
): NonNullable<ModelRoundResult["toolCalls"]>[number] {
  return {
    id,
    name,
    arguments: arguments_,
    rawArguments: JSON.stringify(arguments_),
  };
}

function toolResponse(
  calls: Array<NonNullable<ModelRoundResult["toolCalls"]>[number]>,
  text?: string,
): ModelRoundResult {
  return { ...(text ? { text } : {}), toolCalls: calls };
}

function messagesWithToolResults(
  request: ModelRoundRequest,
): ModelRoundMessage[] {
  return request.messages.filter((message) => message.role === "tool");
}

function toolMessageOutput(message: ModelRoundMessage | undefined): unknown {
  if (!message) return undefined;
  return (JSON.parse(message.content) as { output?: unknown }).output;
}

test("real Guided Turn enters the BTCC agent-loop through the one-round port", async () => {
  const fixture = createFixture("guided-btcc-loop-entry");
  try {
    const requests: Array<{
      messages: readonly { role: string; content: string }[];
      requestSegmentSources: ModelRoundRequest["requestSegmentSources"];
      attributionArmId: ModelRoundRequest["attributionArmId"];
      cacheBoundaryEvidence: ModelRoundRequest["cacheBoundaryEvidence"];
    }> = [];
    const modelRound: ModelRoundPort = {
      async runRound(request) {
        requests.push({
          messages: request.messages,
          requestSegmentSources: request.requestSegmentSources,
          attributionArmId: request.attributionArmId,
          cacheBoundaryEvidence: request.cacheBoundaryEvidence,
        });
        return { text: "BTCC final answer", toolCalls: [] };
      },
    };
    const agent = createProductionGuidedTurnAgent({
      butlerHome: fixture.root,
      butlerData: fixture.root,
      contextDocuments: fixture.stores.contextDocuments,
      toolJournal: fixture.stores.guidedToolJournal,
      effectJournal: fixture.stores.guidedEffectJournal,
      durableWork: fixture.stores.durableWork,
      modelRound,
    });

    const result = await agent.run({
      turn: turnRecord(fixture.root, {
        turnId: "guided-btcc-loop-entry",
        attributionArmId: "direct-cold",
        cacheBoundaryEvidence: { expectedRevision: "expected", observedRevision: "observed" },
      }),
      signal: new AbortController().signal,
      recordModelRoundAcceptance: async () => {},
      loadModelRoundAcceptance: async () => undefined,
    });

    expect(result.content).toBe("BTCC final answer");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.requestSegmentSources?.input?.map((source) => source.kind))
      .toContain("current_user_request");
    expect(requests[0]?.requestSegmentSources?.instructions?.map((source) => source.kind))
      .toContain("stable_btcc_protocol");
    expect(requests[0]?.cacheBoundaryEvidence).toEqual({
      expectedRevision: "expected", observedRevision: "observed",
    });
    expect(requests[0]?.attributionArmId).toBe("direct-cold");
    expect(requests[0]?.messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("요청을 처리해 주세요"),
    });
  } finally {
    fixture.close();
  }
});

test("production Guided Turn sends the admitted M1 v2 direct surface and stable prefix", async () => {
  const fixture = createFixture("guided-m1-v2-direct-surface");
  const previousFlag = process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE;
  process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = "on";
  try {
    let captured: ModelRoundRequest | undefined;
    const agent = fixture.agent({
      async runRound(request) {
        captured = request;
        return { text: "direct answer", toolCalls: [] };
      },
    });
    const result = await agent.run({
      turn: turnRecord(fixture.root, {
        turnId: "guided-m1-v2-direct-surface",
        accessMode: "read_only",
        trackingMode: "none",
      }),
      signal: new AbortController().signal,
    });

    expect(result.content).toBe("direct answer");
    expect(captured?.tools.map((tool) => tool.name)).toContain("web_search");
    expect(captured?.tools.map((tool) => tool.name)).toContain("recall_memory");
    expect(captured?.tools.map((tool) => tool.name)).not.toContain("read_file");
    expect(captured?.tools.map((tool) => tool.name)).not.toContain("replace_work_plan");
    expect(captured?.instructions).toContain("This is a direct non-project phase");
    expect(captured?.instructions).not.toContain("The Work stage is process guidance");
  } finally {
    if (previousFlag === undefined) {
      delete process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE;
    } else {
      process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = previousFlag;
    }
    fixture.close();
  }
});

test("production Guided Turn exposes and executes exact result reads only through selected phase capability", async () => {
  const fixture = createFixture("guided-m1-v2-exact-read");
  const previousFlag = process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
  process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = "on";
  const turnId = "guided-m1-v2-exact-read";
  try {
    fixture.stores.guidedToolJournal.start({
      turnId, callId: "durable-result", toolName: "read_file",
      rawArguments: "{}", arguments: {},
    });
    fixture.stores.guidedToolJournal.finish({
      callId: "durable-result", status: "completed",
      result: { ok: true, content: "exact durable content" },
    });
    const stored = fixture.stores.guidedToolJournal.findForTurn(turnId, "durable-result")!;
    const requests: ModelRoundRequest[] = [];
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        requests.push(request);
        expect(request.tools.map((tool) => tool.name)).toContain("read_operation_results");
        return toolResponse([toolCall("exact-read", "read_operation_results", {
          result_ref: "durable-result", sha256: stored.resultSha256, revision: null,
          work_id: null, offset: 0, length: 32,
        })]);
      },
      (request) => {
        requests.push(request);
        expect(JSON.stringify(messagesWithToolResults(request))).toContain("base64");
        return { text: "exact result verified", toolCalls: [] };
      },
    ]));
    const turn = turnRecord(fixture.root, {
        turnId, accessMode: "read_only", trackingMode: "none",
      });
    turn.modelRoute = buildModelRoute({
      primaryModelRef: "openai/gpt-5.6-sol", backupModelRefs: [],
      reasoningEffort: "low", catalogGeneration: "test",
    });
    const result = await agent.run({
      turn,
      signal: new AbortController().signal,
      recordModelRoundAcceptance: async () => {},
      loadModelRoundAcceptance: async () => undefined,
    });
    expect(result.content).toBe("exact result verified");
    expect(requests).toHaveLength(2);
  } finally {
    if (previousFlag === undefined) delete process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
    else process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = previousFlag;
    fixture.close();
  }
});

test("enabled exact replay fails before provider dispatch without durable route acceptance ports", async () => {
  const fixture = createFixture("guided-exact-replay-preflight");
  const previousFlag = process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
  process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = "on";
  let calls = 0;
  try {
    const agent = fixture.agent({ async runRound() {
      calls += 1;
      return { text: "must not dispatch", toolCalls: [] };
    } });
    await expect(agent.run({
      turn: turnRecord(fixture.root), signal: new AbortController().signal,
    })).rejects.toThrow("operation_result_route_acceptance_dependency_missing");
    expect(calls).toBe(0);
  } finally {
    if (previousFlag === undefined) delete process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
    else process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = previousFlag;
    fixture.close();
  }
});

test("production Turn resolves a Work created after replay runtime construction", async () => {
  const fixture = createFixture("guided-dynamic-work-exact-read");
  const previousReplay = process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
  const previousSurface = process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE;
  process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = "on";
  process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = "on";
  writeFileSync(join(fixture.root, "large.txt"), "W".repeat(12_000));
  writeFileSync(join(fixture.root, "small.txt"), "small");
  try {
    let reference: Record<string, unknown> | undefined;
    let rounds = 0;
    const agent = fixture.agent(scriptedModelRound([
      () => { rounds += 1; return toolResponse([toolCall("plan", "replace_work_plan", {
        objective: "Read one durable large result",
        actions: [{ action_key: "read", description: "Read the large file" }],
        checks: ["The exact range is available"],
      })]); },
      () => { rounds += 1; return toolResponse([toolCall("large", "read_file", { path: "large.txt" })]); },
      () => { rounds += 1; return toolResponse([toolCall("small", "read_file", { path: "small.txt" })]); },
      (request) => {
        rounds += 1;
        const referenceMessage = messagesWithToolResults(request)
          .find((message) => message.name === "read_file" &&
            message.content.includes("butler.operation-result-reference.v1"));
        expect(referenceMessage).toBeDefined();
        reference = JSON.parse(referenceMessage!.content) as Record<string, unknown>;
        const identity = reference.identity as Record<string, unknown>;
        const integrity = reference.integrity as Record<string, unknown>;
        expect(identity.kind).toBe("work");
        expect(identity.work_id).toBeString();
        return toolResponse([toolCall("exact", "read_operation_results", {
          result_ref: identity.result_ref, sha256: integrity.sha256,
          revision: integrity.revision, work_id: identity.work_id,
          offset: 0, length: 64,
        })]);
      },
      (request) => {
        rounds += 1;
        const exact = messagesWithToolResults(request).find((message) => message.name === "read_operation_results");
        expect(JSON.parse(exact!.content)).toMatchObject({
          ok: true, output: { encoding: "base64", offset: 0, length: 64 },
        });
        return { text: "dynamic Work exact range verified", toolCalls: [] };
      },
    ]));
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    const command = localRunCommand(fixture.root, "dynamic-work-turn");
    command.modelSelection.modelRoute = buildModelRoute({
      primaryModelRef: "openai/gpt-5.6-sol", backupModelRefs: [],
      reasoningEffort: "low", catalogGeneration: "test",
    });
    const result = await runtime.runTurn(command);
    expect(rounds).toBe(5);
    expect(reference).toBeDefined();
    expect(result).toMatchObject({
      kind: "delivered", content: "dynamic Work exact range verified",
    });
  } finally {
    if (previousReplay === undefined) delete process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
    else process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = previousReplay;
    if (previousSurface === undefined) delete process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE;
    else process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = previousSurface;
    fixture.close();
  }
});

test("production Guided Turn projects economical results through the actual Codex serializer", async () => {
  const fixture = createFixture("guided-m1-v2-codex-exact-replay");
  const previousFlag = process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
  const previousBase = process.env.BUTLER_CODEX_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = "on";
  process.env.BUTLER_CODEX_BASE_URL = "https://example.test/backend-api";
  writeFileSync(join(fixture.root, "large.txt"), "L".repeat(2_700));
  writeFileSync(join(fixture.root, "small.txt"), "small evidence");
  bindAppProject(fixture.dbPath, {
    id: "guided-agent-session", workspacePath: fixture.root,
    ledgerProjectId: "guided-m1-v2-codex-exact-replay",
  });
  const requestBodies: Record<string, unknown>[] = [];
  let responseIndex = 0;
  globalThis.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
    responseIndex += 1;
    const items = responseIndex === 1
      ? [{ type: "function_call", call_id: "large-read", name: "read_file", arguments: JSON.stringify({ path: "large.txt" }) }]
      : responseIndex === 2
        ? [{ type: "function_call", call_id: "small-read", name: "read_file", arguments: JSON.stringify({ path: "small.txt" }) }]
        : [{ type: "message", content: [{ type: "output_text", text: "serializer verified" }] }];
    const output = items.map((item) =>
      `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
    ).join("");
    const completed = { type: "response.completed", response: {
      id: `response-${responseIndex}`, status: "completed", output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 } },
    } };
    return new Response(`${output}data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`);
  }) as typeof fetch;
  try {
    const authorization = `Bearer e30.${Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account" },
    })).toString("base64url")}.signature`;
    const agent = fixture.agent({
      async runRound(request) {
        const result = await runOpenAIModelRound(
          request, { authorization, mode: "codex_oauth" }, "openai/gpt-5.6-sol",
        );
        return result;
      },
    });
    const turn = turnRecord(fixture.root, {
        turnId: "guided-m1-v2-codex-exact-replay",
        accessMode: "read_only", trackingMode: "none",
        projectId: "guided-m1-v2-codex-exact-replay",
      });
    turn.modelRoute = buildModelRoute({
      primaryModelRef: "openai/gpt-5.6-sol", backupModelRefs: [],
      reasoningEffort: "low", catalogGeneration: "test",
    });
    const result = await agent.run({
      turn,
      signal: AbortSignal.timeout(20_000),
      recordModelRoundAcceptance: async () => {},
      loadModelRoundAcceptance: async () => undefined,
    });
    expect(result.content).toBe("serializer verified");
    expect(requestBodies).toHaveLength(3);
    const second = JSON.stringify(requestBodies[1]);
    const third = JSON.stringify(requestBodies[2]);
    expect(second).toContain("L".repeat(1024));
    expect(third).not.toContain("L".repeat(1024));
    expect(third).toContain("butler.operation-result-reference.v1");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousFlag === undefined) delete process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
    else process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = previousFlag;
    if (previousBase === undefined) delete process.env.BUTLER_CODEX_BASE_URL;
    else process.env.BUTLER_CODEX_BASE_URL = previousBase;
    fixture.close();
  }
}, 30_000);

test("production Guided Turn preserves official Responses continuation for economical replay", async () => {
  const fixture = createFixture("guided-m1-v2-official-exact-replay");
  const previousFlag = process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
  const previousBase = process.env.OPENAI_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = "on";
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  writeFileSync(join(fixture.root, "official-large.txt"), "O".repeat(2_700));
  writeFileSync(join(fixture.root, "official-small.txt"), "small");
  const bodies: Record<string, unknown>[] = [];
  const responses = [
    { id: "official-1", model: "gpt-5.6-sol", output: [{
      type: "function_call", call_id: "official-large", name: "read_file",
      arguments: JSON.stringify({ path: "official-large.txt" }),
    }] },
    { id: "official-2", model: "gpt-5.6-sol", output: [{
      type: "function_call", call_id: "official-small", name: "read_file",
      arguments: JSON.stringify({ path: "official-small.txt" }),
    }] },
    { id: "official-3", model: "gpt-5.6-sol", output: [{
      type: "message", role: "assistant",
      content: [{ type: "output_text", text: "official serializer verified" }],
    }] },
  ];
  let responseIndex = 0;
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json(responses[responseIndex++]!);
  }) as typeof fetch;
  try {
    const agent = fixture.agent({ runRound: (request) => runOpenAIModelRound(
      request, { authorization: "Bearer test-key", mode: "api_key" },
      "openai/gpt-5.6-sol",
    ) });
    const turn = turnRecord(fixture.root, {
      turnId: "guided-official-exact", accessMode: "read_only", trackingMode: "none",
    });
    turn.modelRoute = buildModelRoute({
      primaryModelRef: "openai/gpt-5.6-sol", backupModelRefs: [],
      reasoningEffort: "low", catalogGeneration: "test",
    });
    const result = await agent.run({
      turn, signal: new AbortController().signal,
      loadModelRoundAcceptance: async () => undefined,
      recordModelRoundAcceptance: async () => {},
    });
    expect(result.content).toBe("official serializer verified");
    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies[1])).toContain("O".repeat(1024));
    expect(bodies[1]?.previous_response_id).toBe("official-1");
    expect(JSON.stringify(bodies[2])).not.toContain("O".repeat(1024));
    expect(JSON.stringify(bodies[2])).not.toContain("butler.operation-result-reference.v1");
    expect(bodies[2]?.previous_response_id).toBe("official-2");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousFlag === undefined) delete process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
    else process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = previousFlag;
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    fixture.close();
  }
}, 30_000);

test("production M1 v2 read-only surface executes an admitted native registry tool", async () => {
  const fixture = createFixture("guided-m1-v2-read-only-native");
  const previousFlag = process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE;
  process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = "on";
  writeFileSync(join(fixture.root, "evidence.txt"), "native evidence\n");
  bindAppProject(fixture.dbPath, {
    id: "guided-agent-session",
    workspacePath: fixture.root,
    ledgerProjectId: "guided-m1-v2-read-only",
  });
  try {
    const requests: ModelRoundRequest[] = [];
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        requests.push(request);
        return toolResponse([toolCall("read-evidence", "read_file", {
          path: "evidence.txt",
        })]);
      },
      (request) => {
        requests.push(request);
        expect(JSON.stringify(messagesWithToolResults(request)))
          .toContain("native evidence");
        return { text: "read-only evidence accepted", toolCalls: [] };
      },
    ]));
    const result = await agent.run({
      turn: turnRecord(fixture.root, {
        turnId: "guided-m1-v2-read-only-native",
        accessMode: "read_only",
        trackingMode: "none",
        projectId: "guided-m1-v2-read-only",
      }),
      signal: new AbortController().signal,
    });

    expect(result.content).toBe("read-only evidence accepted");
    expect(requests[0]?.tools.map((tool) => tool.name)).toContain("read_file");
    expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("write_file");
    expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("run_command");
  } finally {
    if (previousFlag === undefined) {
      delete process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE;
    } else {
      process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = previousFlag;
    }
    fixture.close();
  }
});

test("production M1 v2 execution instructions preserve the reviewed Work lifecycle", async () => {
  const fixture = createFixture("guided-m1-v2-execution-instructions");
  const previousFlag = process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE;
  process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = "on";
  bindAppProject(fixture.dbPath, {
    id: "guided-agent-session",
    workspacePath: fixture.root,
    ledgerProjectId: "guided-m1-v2-execution",
  });
  try {
    let captured: ModelRoundRequest | undefined;
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        captured = request;
        return toolResponse([toolCall("lifecycle-search", "tool_search", {
          query: "project_ledger_work_complete",
          include_disabled: true,
        })]);
      },
      { text: "execution instructions accepted", toolCalls: [] },
    ]));
    await agent.run({
      turn: turnRecord(fixture.root, {
        turnId: "guided-m1-v2-execution-instructions",
        accessMode: "full_access",
        trackingMode: "ledger",
        projectId: "guided-m1-v2-execution",
      }),
      signal: new AbortController().signal,
    });

    expect(captured?.instructions).toContain("create or reuse one Work");
    expect(captured?.instructions).toContain("accepted Plan Review");
    expect(captured?.instructions).toContain("execute the effect");
    expect(captured?.instructions).toContain("review its actual result");
    expect(captured?.instructions).toContain("validate completion");
    expect(captured?.instructions).toContain("close out the Work");
    expect(captured?.instructions).toContain("admitted native tools");
    expect(captured?.tools.map((tool) => tool.name)).toContain("replace_work_plan");
    expect(captured?.tools.map((tool) => tool.name)).toContain("run_command");
    expect(captured?.tools.map((tool) => tool.name))
      .not.toContain("project_ledger_work_complete");
    expect(JSON.stringify(fixture.stores.guidedToolJournal.list(
      "guided-m1-v2-execution-instructions",
    ))).toContain("native:project_ledger_work_complete");
  } finally {
    if (previousFlag === undefined) {
      delete process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE;
    } else {
      process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = previousFlag;
    }
    fixture.close();
  }
});

test("production Guided Turn rereads Work across execution windows in one agent run", async () => {
  const fixture = createFixture("guided-production-window-continuation");
  try {
    const requests: ModelRoundRequest[] = [];
    let modelCalls = 0;
    let loadContextCalls = 0;
    let boundWorkCalls = 0;
    const durableWork = fixture.stores.durableWork;
    const trackedDurableWork = {
      ...durableWork,
      async loadContext(scope: Parameters<typeof durableWork.loadContext>[0]) {
        loadContextCalls += 1;
        return durableWork.loadContext(scope);
      },
      async boundWorkForTurn(turnId: string) {
        boundWorkCalls += 1;
        return durableWork.boundWorkForTurn(turnId);
      },
    };
    const modelRound: ModelRoundPort = {
      async runRound(request) {
        requests.push(request);
        modelCalls += 1;
        if (modelCalls === 1) {
          return toolResponse([toolCall("window-plan", "replace_work_plan", {
            start_new: true,
            objective: "Preserve evidence across the execution windows.",
            actions: [{
              action_key: "preserve-evidence",
              description: "Keep the collected evidence available for the final answer.",
            }],
            checks: ["The final answer uses the collected evidence."],
          })]);
        }
        if (modelCalls === 2) {
          return toolResponse([toolCall("window-checkpoint", "record_work_checkpoint", {
            action_updates: [{
              action_key: "preserve-evidence",
              status: "active",
            }],
            public_summary: "The collected evidence remains available.",
            next_step: "Use the evidence in the final answer.",
          })]);
        }
        return { text: "확인된 근거를 바탕으로 답변을 완료했습니다.", toolCalls: [] };
      },
    };
    const agent = createProductionGuidedTurnAgent({
      butlerHome: fixture.root,
      butlerData: fixture.root,
      contextDocuments: fixture.stores.contextDocuments,
      toolJournal: fixture.stores.guidedToolJournal,
      effectJournal: fixture.stores.guidedEffectJournal,
      durableWork: trackedDurableWork,
      modelRound,
      executionWindowSize: 1,
    });
    const turnId = "guided-production-window-turn";
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    const result = await runtime.runTurn(localRunCommand(fixture.root, turnId));
    expect(result).toMatchObject({
      kind: "delivered",
      content: "확인된 근거를 바탕으로 답변을 완료했습니다.",
    });
    expect(modelCalls).toBe(3);
    expect(loadContextCalls).toBeGreaterThanOrEqual(3);
    expect(boundWorkCalls).toBeGreaterThanOrEqual(3);
    expect(requests).toHaveLength(3);
    expect(requests[0]?.messages.filter((message) => message.role === "user"))
      .toHaveLength(1);
    expect(requests[1]?.messages.filter((message) => message.role === "user"))
      .toHaveLength(2);
    expect(requests[2]?.messages.filter((message) => message.role === "user"))
      .toHaveLength(3);
    expect(requests[1]?.messages.at(-1)?.content).toContain("Execution checkpoint 1");
    expect(requests[1]?.messages.at(-1)?.content).toContain("Durable Work status");
    expect(requests[2]?.messages.at(-1)?.content).toContain("Execution checkpoint 2");
    expect(requests[2]?.messages.at(-1)?.content)
      .toContain("The collected evidence remains available.");
  } finally {
    fixture.close();
  }
});

test("Guided fallback projects the cursor model into public iteration and fallback evidence", async () => {
  const fixture = createFixture("guided-model-route-projection");
  try {
    const requests: string[] = [];
    const iterationModels: string[] = [];
    const fallbackModels: string[] = [];
    const agent = fixture.agent({
      async runRound(request) {
        requests.push(String(request.model));
        if (request.model === "openai/gpt-5.5") {
          throw new ModelProviderRequestError({
            code: "provider_rate_limited",
            message: "rate limited",
            provider: "openai",
            retryable: true,
          });
        }
        if (requests.filter((model) => model === "zai/glm-5.2").length === 1) {
          return {
            toolCalls: [toolCall("capabilities-1", "list_tool_capabilities", {})],
          };
        }
        return { text: "backup answer", toolCalls: [] };
      },
    });
    const turn = turnRecord(fixture.root, {
      turnId: "guided-model-route-projection",
    });
    turn.modelRoute = buildModelRoute({
      primaryModelRef: "openai/gpt-5.5",
      backupModelRefs: ["zai/glm-5.2"],
      reasoningEffort: "medium",
      retryCeiling: 1,
    });
    await agent.run({
      turn,
      signal: new AbortController().signal,
      progress: {
        stateChanged() {},
        modelRoundWaitingChanged(update) {
          if (update.status === "started" && update.modelRef) {
            iterationModels.push(update.modelRef);
          }
        },
        phaseActivityChanged(update) {
          if (update.modelRef) fallbackModels.push(update.modelRef);
        },
      },
    });

    expect(requests).toEqual([
      "openai/gpt-5.5",
      "zai/glm-5.2",
      "zai/glm-5.2",
    ]);
    expect(iterationModels).toEqual([
      "openai/gpt-5.5",
      "zai/glm-5.2",
      "zai/glm-5.2",
    ]);
    expect(fallbackModels).toEqual(["zai/glm-5.2"]);
  } finally {
    fixture.close();
  }
});

test("primary-only route uses the durable routed path", async () => {
  const fixture = createFixture("guided-primary-only-route");
  try {
    let routeEvents = 0;
    let acceptedResponses = 0;
    let attemptHistoryLoads = 0;
    const agent = fixture.agent({
      async runRound() {
        return {
          text: "primary answer",
          toolCalls: [],
          providerIdentity: {
            provider: "openai",
            configuredModel: "openai/gpt-5.5",
            reportedModel: "gpt-5.5-served",
          },
        };
      },
    });
    const turn = turnRecord(fixture.root, { turnId: "guided-primary-only-route" });
    turn.modelRoute = buildModelRoute({
      primaryModelRef: "openai/gpt-5.5",
      reasoningEffort: "medium",
      retryCeiling: 3,
    });
    const result = await agent.run({
      turn,
      signal: new AbortController().signal,
      recordModelRouteEvent: async () => {
        routeEvents += 1;
      },
      loadModelRouteAttemptHistory: async () => {
        attemptHistoryLoads += 1;
        return { started: [], failed: [], succeeded: [], abandoned: [] };
      },
      loadModelRoundAcceptance: async () => undefined,
      recordModelRoundAcceptance: async () => {
        acceptedResponses += 1;
      },
    });

    expect(routeEvents).toBe(1);
    expect(acceptedResponses).toBe(1);
    expect(attemptHistoryLoads).toBe(1);
    expect(result.modelIdentity).toEqual({
      requestedModelRef: "openai/gpt-5.6-sol",
      effectiveModelRef: "openai/gpt-5.5",
      providerReportedModelRef: "openai/gpt-5.5-served",
    });
  } finally {
    fixture.close();
  }
});

test("Guided model rounds attribute provider usage before completion progress", async () => {
  const fixture = createFixture("guided-usage-attribution");
  try {
    const events: string[] = [];
    const turnId = "guided-usage-attribution";
    const agent = fixture.agent({
      async runRound(request) {
        events.push(`metric:${request.usageAttribution?.turnId ?? "missing"}`);
        return { text: "BTCC final answer", toolCalls: [] };
      },
    });

    await agent.run({
      turn: turnRecord(fixture.root, { turnId }),
      signal: new AbortController().signal,
      progress: {
        stateChanged() {},
        modelRoundWaitingChanged(update) {
          events.push(update.status);
        },
      },
    });

    expect(events).toEqual(["started", `metric:${turnId}`, "completed"]);
  } finally {
    fixture.close();
  }
});

test("Guided Turn promotes persona and profile context into every provider instruction", async () => {
  const fixture = createFixture("guided-persona-instructions");
  try {
    const personaRef = fixture.stores.contextDocuments.persist({
      scopeKind: "user",
      scopeId: "local-user",
      projectionClass: "profile",
      sourceId: "active-persona-reminder",
      sourceRevision: "persona-v1",
      content: "## Active Persona Reminder\n\n말끝에 반드시 냥을 붙인다.",
    });
    const profileRef = fixture.stores.contextDocuments.persist({
      scopeKind: "user",
      scopeId: "local-user",
      projectionClass: "profile",
      sourceId: "personalization-profile",
      sourceRevision: "profile-v1",
      content: "## Personalization Profile\n\nPreferred address: 사용자님",
    });
    const runtimeRef = fixture.stores.contextDocuments.persist({
      scopeKind: "session",
      scopeId: "guided-persona-instructions",
      projectionClass: "optional_hot_cache",
      sourceId: "runtime-state",
      sourceRevision: "runtime-v1",
      content: "## Turn Environment\nAssistant Response Language: Korean",
    });
    const instructions: Array<string | undefined> = [];
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        instructions.push(request.instructions);
        return toolResponse([toolCall("read-1", "read_file", { path: "README.md" })]);
      },
      (request) => {
        instructions.push(request.instructions);
        return { text: "확인했냥.", toolCalls: [] };
      },
    ]));
    const turn = turnRecord(fixture.root, { turnId: "guided-persona-instructions" });
    turn.context.profileRefs = [personaRef, profileRef];
    turn.context.optionalHotCacheRefs = [runtimeRef];

    await agent.run({ turn, signal: new AbortController().signal });

    expect(instructions).toHaveLength(2);
    for (const value of instructions) {
      expect(value).toContain("Active Persona Reminder");
      expect(value).toContain("말끝에 반드시 냥을 붙인다.");
      expect(value).toContain("Preferred address: 사용자님");
      expect(value).toContain("Use Korean for every user-facing message");
    }
  } finally {
    fixture.close();
  }
});

test("Guided agent leaves web query planning to the selected model", async () => {
  const fixture = createFixture("guided-model-owned-search");
  try {
    writeFileSync(join(fixture.root, "butler.config.json"), JSON.stringify({
      webSearch: { provider: "mock" },
    }));
    let searchResult: Record<string, any> | undefined;
    const turnId = "guided-model-owned-search";
    const agent = fixture.agent(scriptedModelRound([
      toolResponse([toolCall("search-1", "web_search", {
        query: "Butler guided search ownership",
      })]),
      { text: "검색했습니다.", toolCalls: [] },
    ]));

    await agent.run({
      turn: turnRecord(fixture.root, { turnId }),
      signal: new AbortController().signal,
    });
    searchResult = fixture.stores.guidedToolJournal.list(turnId)[0]?.result as
      Record<string, any> | undefined;

    expect(searchResult?.search_plan).toMatchObject({
      mode: "direct",
      planner_used: false,
      planner_attempts: 0,
      original_query: "Butler guided search ownership",
    });
    expect(searchResult?.search_plan?.fallback_reason).toBe(
      "guided model owns search planning",
    );
  } finally {
    fixture.close();
  }
});

test("Guided agent exposes only typed Project Ledger effects in a writable project turn", async () => {
  const fixture = createFixture("guided-policy");
  try {
    const availability = async (turn: TurnRecord, query = "project_ledger_create") => {
      let result: unknown;
      const agent = fixture.agent(scriptedModelRound([
        toolResponse([toolCall("search-1", "tool_search", {
          query,
          include_disabled: true,
        })]),
        { text: "확인했습니다.", toolCalls: [] },
      ]));
      await agent.run({ turn, signal: new AbortController().signal });
      result = fixture.stores.guidedToolJournal.list(turn.turnId)[0]?.result;
      const results = (result as { results?: Array<{ id: string; enabled: boolean }> }).results ?? [];
      return results.find((entry) => entry.id === `native:${query}`)?.enabled;
    };

    let updateDescription: unknown;
    const descriptionTurnId = "turn-project-description";
    const descriptionAgent = fixture.agent(scriptedModelRound([
      toolResponse([toolCall("describe-1", "tool_describe", {
        ids: ["native:project_ledger_update"],
      })]),
      { text: "확인했습니다.", toolCalls: [] },
    ]));

    const fullAccessProjectTurn = turnRecord(fixture.root, {
      accessMode: "full_access",
      trackingMode: "ledger",
      projectId: "project-1",
    });
    expect(await availability(fullAccessProjectTurn)).toBe(true);
    await descriptionAgent.run({
      turn: {
        ...fullAccessProjectTurn,
        turnId: descriptionTurnId,
        inboxId: "inbox:turn-project-description",
        triggerKey: "trigger:turn-project-description",
        originalMessageId: "message:turn-project-description",
      },
      signal: new AbortController().signal,
    });
    updateDescription = fixture.stores.guidedToolJournal.list(descriptionTurnId)[0]?.result;
    expect(JSON.stringify(updateDescription)).toContain('"required":["kind","id"]');
    expect(await availability(fullAccessProjectTurn, "render_project_dashboard"))
      .toBeUndefined();
    expect(await availability(fullAccessProjectTurn, "complete_project_work"))
      .toBeUndefined();
    expect(await availability(turnRecord(fixture.root, {
      accessMode: "read_only",
      trackingMode: "ledger",
      projectId: "project-1",
      turnId: "turn-read-only",
    }))).toBeUndefined();

    let visibleNames: string[] = [];
    let writeFileSchema = "";
    let editFileSchema = "";
    let instructions = "";
    const projectAgent = fixture.agent({
      async runRound(request) {
        visibleNames = request.tools.map((tool) => tool.name);
        writeFileSchema = JSON.stringify(
          request.tools.find((tool) => tool.name === "write_file")?.parameters,
        );
        editFileSchema = JSON.stringify(
          request.tools.find((tool) => tool.name === "edit_file")?.parameters,
        );
        instructions = request.instructions ?? "";
        return { text: "준비했습니다.", toolCalls: [] };
      },
    });
    await projectAgent.run({
      turn: turnRecord(fixture.root, {
        accessMode: "full_access",
        trackingMode: "ledger",
        projectId: "project-visible",
        turnId: "turn-project-visible",
      }),
      signal: new AbortController().signal,
    });
    expect(visibleNames).toContain("write_file");
    expect(visibleNames).toContain("edit_file");
    expect(writeFileSchema).not.toContain("expected_sha256");
    expect(writeFileSchema).not.toContain("overwrite");
    expect(writeFileSchema).toContain("create_parents");
    expect(editFileSchema).not.toContain("expected_sha256");
    expect(visibleNames).toContain("project_ledger_status");
    expect(visibleNames).toContain("project_ledger_list");
    expect(visibleNames).not.toContain("project_ledger_show");
    expect(visibleNames).toContain("project_ledger_create");
    expect(visibleNames).not.toContain("project_ledger_work_update");
    expect(visibleNames).toContain("project_ledger_work_complete");
    expect(instructions).toContain("keep one concise Project Ledger Work record");
    expect(instructions).toContain("Check for related Work first and reuse it");
    expect(instructions).toContain(
      "complete it after validating the requested outcome",
    );
    expect(instructions).not.toContain(
      "Do not attempt to mutate the Project Ledger",
    );

    let localVisibleNames: string[] = [];
    let localSearch: unknown;
    let localDescription: unknown;
    let localCatalogCall: unknown;
    let localDirectCall: unknown;
    const localTurnId = "turn-project-local-work";
    const localAgent = fixture.agent(scriptedModelRound([
      toolResponse([
        toolCall("search-1", "tool_search", {
          query: "project_ledger_create",
          include_disabled: true,
        }),
        toolCall("describe-1", "tool_describe", {
          ids: ["native:project_ledger_create"],
        }),
        toolCall("catalog-1", "tool_call", {
          id: "native:project_ledger_create",
          arguments: {
            kind: "work",
            id: "W-MUST-NOT-EXIST",
            title: "Must not exist",
            acceptance: "Must remain unavailable",
          },
        }),
        toolCall("direct-1", "project_ledger_create", {
          kind: "work",
          id: "W-MUST-NOT-EXIST",
          title: "Must not exist",
          acceptance: "Must remain unavailable",
        }),
      ]),
      (request) => {
        localVisibleNames = request.tools.map((tool) => tool.name);
        const messages = messagesWithToolResults(request);
        expect(messages).toHaveLength(4);
        localSearch = toolMessageOutput(
          messages.find((message) => message.toolCallId === "search-1"),
        );
        localDescription = toolMessageOutput(
          messages.find((message) => message.toolCallId === "describe-1"),
        );
        localCatalogCall = toolMessageOutput(
          messages.find((message) => message.toolCallId === "catalog-1"),
        );
        localDirectCall = toolMessageOutput(
          messages.find((message) => message.toolCallId === "direct-1"),
        );
        return { text: "세션 작업으로 처리했습니다.", toolCalls: [] };
      },
    ]));
    await localAgent.run({
      turn: turnRecord(fixture.root, {
        accessMode: "full_access",
        trackingMode: "local",
        projectId: "project-local",
        turnId: localTurnId,
      }),
      signal: new AbortController().signal,
    });
    expect(localVisibleNames).not.toContain("project_ledger_create");
    expect(localVisibleNames).not.toContain("project_ledger_work_complete");
    expect((localSearch as { results?: Array<{ id: string }> }).results ?? [])
      .not.toContainEqual(expect.objectContaining({
        id: "native:project_ledger_create",
      }));
    expect(localDescription).toMatchObject({
      ok: false,
      descriptions: [],
      missing: [{
        id: "native:project_ledger_create",
        error: "unknown_tool_catalog_id",
      }],
    });
    expect(localCatalogCall).toMatchObject({ ok: false });
    expect(localDirectCall).toMatchObject({
      ok: false,
      observation_kind: "tool_unavailable",
    });
  } finally {
    fixture.close();
  }
});

test("Guided project Work initializes and closes Project Ledger through reviewed effects", async () => {
  const fixture = createFixture("guided-project-ledger-lifecycle");
  const previousFlag = process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE;
  process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = "on";
  const ledgerRoot = join(
    fixture.root,
    "project-ledger",
    "projects",
    "guided-ledger-project",
  );
  writeFileSync(
    join(fixture.root, "package.json"),
    `${JSON.stringify({ name: "guided-ledger-project" })}\n`,
  );
  bindAppProject(fixture.dbPath, {
    id: "guided-project-session",
    workspacePath: fixture.root,
    ledgerProjectId: "guided-ledger-project",
  });
  try {
    const turnId = "turn-guided-project-ledger-lifecycle";
    const planCalls = [
      toolCall("plan-1", "replace_work_plan", {
        objective: "Complete one tracked project change",
        actions: [{
          action_key: "create-ledger-work",
          description: "Create one concise Project Ledger Work record",
          effect: {
            capability: "project_ledger_create",
            target: "project-ledger:work:W-GUIDED-LIFECYCLE",
          },
        }, {
          action_key: "complete-ledger-work",
          description: "Complete the Project Ledger Work after validation",
          dependency_keys: ["create-ledger-work"],
          effect: {
            capability: "project_ledger_work_complete",
            target: "project-ledger:work:W-GUIDED-LIFECYCLE",
          },
        }],
        checks: ["The canonical Project Ledger Work is done"],
      }),
      toolCall("plan-review-1", "record_work_review", {
        subject: "plan",
        verdict: "accept",
        summary: "The plan is concise and matches the project request.",
      }),
    ];
    const searchCalls = [
      toolCall("search-create", "tool_search", {
        query: "project_ledger_create",
        include_disabled: true,
      }),
      toolCall("search-complete", "tool_search", {
        query: "project_ledger_work_complete",
        include_disabled: true,
      }),
    ];
    const describeCalls = [toolCall("describe-effects", "tool_describe", {
      ids: [
        "native:project_ledger_create",
        "native:project_ledger_work_complete",
      ],
    })];
    const createCalls = [toolCall("create-1", "tool_call", {
      id: "native:project_ledger_create",
      arguments: {
        kind: "work",
        id: "W-GUIDED-LIFECYCLE",
        title: "Guided project lifecycle",
        status: "proposed",
        spec: "SPEC-GUIDED-LIFECYCLE",
        acceptance: "The tracked project result is validated and reported",
      },
    })];
    const completeCalls = [toolCall("complete-1", "tool_call", {
      id: "native:project_ledger_work_complete",
      arguments: {
        id: "W-GUIDED-LIFECYCLE",
        validation: "Lifecycle integration test passed",
        review: "The requested tracked outcome is complete",
        report: "The Guided result contains the completed outcome",
      },
    })];
    const reviewCalls = [
      toolCall("checkpoint-1", "record_work_checkpoint", {
        action_updates: [{ action_key: "create-ledger-work", status: "done" }, {
          action_key: "complete-ledger-work",
          status: "done",
        }],
        public_summary: "The Project Ledger Work was created and completed.",
        next_step: "Review the completed project result.",
      }),
      toolCall("result-review-1", "record_work_review", {
        subject: "result",
        verdict: "accept",
        summary: "The Project Ledger Work was created and completed.",
      }),
      toolCall("completion-1", "record_work_review", {
        subject: "completion",
        verdict: "accept",
        next_stage: "reporting",
        summary: "The whole Work satisfies the original project request and checks.",
      }),
    ];
    const agent = fixture.agent(scriptedModelRound([
      toolResponse(planCalls),
      toolResponse(searchCalls),
      toolResponse(describeCalls),
      toolResponse(createCalls),
      toolResponse(completeCalls),
      toolResponse(reviewCalls),
      (request) => {
        expect(existsSync(ledgerRoot)).toBe(true);
        expect(request.messages.some((message) => message.role === "tool")).toBe(true);
        return { text: "프로젝트 작업과 기록을 완료했습니다.", toolCalls: [] };
      },
    ]), { butlerHome: process.cwd() });
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    const delivered = await runtime.runTurn(projectRunCommand(fixture.root, turnId));
    expect(delivered)
      .toMatchObject({
      kind: "delivered",
      content: "프로젝트 작업과 기록을 완료했습니다.",
    });
    const journal = fixture.stores.guidedToolJournal.list(turnId);
    expect(journal.find((entry) => entry.toolName === "tool_search" &&
      JSON.stringify(entry.arguments).includes("project_ledger_create"))?.result)
      .toMatchObject({ results: [expect.objectContaining({
        id: "native:project_ledger_create",
        enabled: true,
      })] });
    expect(journal.find((entry) => entry.toolName === "tool_describe")?.result)
      .toMatchObject({ ok: true, missing: [] });
    expect(journal.find((entry) => entry.toolName === "project_ledger_create")?.result)
      .toMatchObject({ ok: true });
    expect(journal.find((entry) => entry.toolName === "project_ledger_work_complete")?.result)
      .toMatchObject({ ok: true });
    expect(existsSync(join(ledgerRoot, "project.json"))).toBe(true);
    expect(existsSync(join(ledgerRoot, "work", "W-GUIDED-LIFECYCLE", "work.md")))
      .toBe(true);
    const work = await fixture.stores.durableWork.boundWorkForTurn(turnId);
    expect(work).toMatchObject({
      status: "completed",
      latestResultReview: { verdict: "accept" },
      latestCompletionValidation: { verdict: "accept" },
    });
    expect(fixture.stores.guidedEffectJournal.listForWork(work!.workId))
      .toHaveLength(2);
    expect((await fixture.stores.turns.findTurn(turnId))?.route).toBe("managed");
  } finally {
    if (previousFlag === undefined) {
      delete process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE;
    } else {
      process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = previousFlag;
    }
    fixture.close();
  }
});

test("Guided Project Ledger mutation uses bounded workspace context without App rows", async () => {
  for (const archived of [false, true]) {
    const fixture = createFixture(
      archived ? "guided-archived-project-binding" : "guided-missing-project-binding",
    );
    const ledgerId = archived
      ? "archived-ledger-must-not-exist"
      : "missing-ledger-must-not-exist";
    writeFileSync(
      join(fixture.root, "package.json"),
      `${JSON.stringify({ name: ledgerId })}\n`,
    );
    prepareAppProjectsTable(fixture.dbPath);
    if (archived) {
      bindAppProject(fixture.dbPath, {
        id: "guided-project-session",
        workspacePath: fixture.root,
        ledgerProjectId: ledgerId,
        archived: true,
      });
    }
    try {
      let mutationResult: unknown;
      const turnId = archived
        ? "turn-archived-project-binding"
        : "turn-missing-project-binding";
      const agent = fixture.agent(scriptedModelRound([
        toolResponse([
          toolCall("plan-1", "replace_work_plan", {
            objective: "Verify the persistent mutation boundary",
            actions: [{
              action_key: "create-ledger-work",
              description: "Create one Project Ledger Work",
              effect: {
                capability: "project_ledger_create",
                target: "project-ledger:work:W-BINDING-FAIL-CLOSED",
              },
            }],
            checks: ["The bounded workspace context owns project resolution"],
          }),
          toolCall("review-1", "record_work_review", {
            subject: "plan",
            verdict: "accept",
            summary: "The boundary check is safe and scoped.",
          }),
          toolCall("mutation-1", "project_ledger_create", {
            kind: "work",
            id: "W-BINDING-FAIL-CLOSED",
            title: "Create from bounded context",
            acceptance: "No App database lookup is required",
          }),
        ]),
        () => {
          mutationResult = fixture.stores.guidedToolJournal.list(turnId)
            .at(-1)?.result;
          return { text: "bounded context로 기록했습니다.", toolCalls: [] };
        },
      ]), { butlerHome: process.cwd() });
      const runtime = createGuidedTurnRuntime({
        admission: fixture.stores.admission,
        turns: fixture.stores.turns,
        messages: fixture.stores.messages,
        committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
        agent,
      });
      await runtime.runTurn(projectRunCommand(fixture.root, turnId));

      expect(mutationResult).toMatchObject({ ok: true });
      expect(existsSync(join(
        fixture.root,
        "project-ledger",
        "projects",
        ledgerId,
      ))).toBe(true);
    } finally {
      fixture.close();
    }
  }
});

test("Guided agent legacy fallback never grants full access without an admitted access mode", async () => {
  const fixture = createFixture("guided-legacy-policy");
  try {
    const turn = turnRecord(fixture.root, { turnId: "legacy-turn" });
    delete turn.context.executionPolicy;
    turn.modelSelection.controls = {};
    let names: string[] = [];
    let prompt = "";
    const agent = fixture.agent({
      async runRound(request) {
        names = request.tools.map((tool) => tool.name);
        prompt = request.messages[0]?.content ?? "";
        return { text: "읽기 전용으로 확인했습니다.", toolCalls: [] };
      },
    });
    await agent.run({ turn, signal: new AbortController().signal });
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("edit_file");
    expect(prompt).toContain("access: read_only");
  } finally {
    fixture.close();
  }
});

test("Guided agent treats admitted Turn access as the upper permission bound", async () => {
  const fixture = createFixture("guided-access-bound");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "bounded-turn",
      accessMode: "full_access",
    });
    turn.modelSelection.controls = { accessMode: "read_only" };
    turn.context.executionPolicy!.requiredNativeToolProfiles = [
      "automation",
      "memory-write",
      "mcp",
    ];
    turn.context.executionPolicy!.requiredNativeTools = [
      "create_automation",
      "update_explicit_memory",
      "call_mcp_tool",
    ];
    let names: string[] = [];
    const unsafeAvailability: boolean[] = [];
    let deniedMutation: unknown;
    const agent = fixture.agent(scriptedModelRound([
      toolResponse([
        toolCall("search-automation", "tool_search", {
          query: "create_automation",
          include_disabled: true,
        }),
        toolCall("search-memory", "tool_search", {
          query: "update_explicit_memory",
          include_disabled: true,
        }),
        toolCall("search-mcp", "tool_search", {
          query: "call_mcp_tool",
          include_disabled: true,
        }),
        toolCall("write-forbidden", "write_file", {
          path: "forbidden.txt",
          content: "no",
          overwrite: false,
        }),
      ]),
      (request) => {
        names = request.tools.map((tool) => tool.name);
        const messages = messagesWithToolResults(request);
        expect(messages).toHaveLength(4);
        const results = [
          "search-automation",
          "search-memory",
          "search-mcp",
        ].map((id) => toolMessageOutput(
          messages.find((message) => message.toolCallId === id),
        )) as Array<{ results?: Array<{ name: string; enabled: boolean }> }>;
        for (const [index, name] of [
          "create_automation",
          "update_explicit_memory",
          "call_mcp_tool",
        ].entries()) {
          unsafeAvailability.push(
            results[index]?.results?.find((entry) => entry.name === name)?.enabled ?? false,
          );
        }
        deniedMutation = toolMessageOutput(
          messages.find((message) => message.toolCallId === "write-forbidden"),
        );
        return { text: "읽기 권한 범위에서 확인했습니다.", toolCalls: [] };
      },
    ]));
    await agent.run({ turn, signal: new AbortController().signal });
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("write_file");
    expect(unsafeAvailability).toEqual([false, false, false]);
    expect(deniedMutation).toMatchObject({
      ok: false,
      observation_kind: "tool_unavailable",
    });
    expect(existsSync(join(fixture.root, "forbidden.txt"))).toBe(false);
  } finally {
    fixture.close();
  }
});

test("Guided discovery exposes registry read tools without enabling unsupported effects", async () => {
  const fixture = createFixture("guided-unsupported-effects");
  try {
    upsertMcpServer(fixture.root, {
      id: "fixture",
      display_name: "Fixture MCP",
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: ["--eval", fixtureMcpServerEval()],
      cwd: process.cwd(),
    });
    const turn = turnRecord(fixture.root, {
      turnId: "guided-unsupported-effects-turn",
      accessMode: "full_access",
      trackingMode: "local",
    });
    const authorizedNames = authorizedToolDefinitions(turn)
      .map((tool) => tool.name);
    expect(authorizedNames).toContain("list_automations");
    expect(authorizedNames).toContain("list_mcp_capabilities");
    expect(authorizedNames).toContain("read_mcp_resource");
    expect(authorizedNames).toContain("query_memory");
    expect(authorizedNames).toContain("get_usage_monitor");
    expect(authorizedNames).not.toContain("create_automation");
    expect(authorizedNames).not.toContain("call_mcp_tool");
    expect(authorizedNames).not.toContain("transform_public_data_table");

    let initialNames: string[] = [];
    let automationSearch: unknown;
    let mcpSearch: unknown;
    let descriptions: unknown;
    let automationList: unknown;
    let capabilityList: unknown;
    let mcpCapabilities: unknown;
    let mcpResource: unknown;
    let memoryQuery: unknown;
    let usageMonitor: unknown;
    let mcpCall: unknown;
    const agent = fixture.agent(scriptedModelRound([
      toolResponse([
        toolCall("automation-search", "tool_search", {
          provider: "native",
          category: "automation",
          include_disabled: true,
        }),
        toolCall("mcp-search", "tool_search", {
          provider: "mcp",
          category: "mcp",
          capability: "issue",
          include_disabled: true,
        }),
        toolCall("describe", "tool_describe", {
          ids: [
            "native:create_automation",
            "native:list_automations",
            "native:list_tool_capabilities",
            "native:call_mcp_tool",
            "native:list_mcp_capabilities",
            "native:read_mcp_resource",
            "native:query_memory",
            "native:get_usage_monitor",
            "mcp:fixture:find_issue",
          ],
        }),
        toolCall("automation-list", "tool_call", {
          id: "native:list_automations",
          arguments: {},
        }),
        toolCall("capability-list", "tool_call", {
          id: "native:list_tool_capabilities",
          arguments: { include_disabled: true },
        }),
        toolCall("mcp-capabilities", "tool_call", {
          id: "native:list_mcp_capabilities",
          arguments: {},
        }),
        toolCall("mcp-resource", "tool_call", {
          id: "native:read_mcp_resource",
          arguments: { server_id: "fixture", uri: "butler://fixture" },
        }),
        toolCall("memory", "tool_call", {
          id: "native:query_memory",
          arguments: { scope: "session" },
        }),
        toolCall("usage", "tool_call", {
          id: "native:get_usage_monitor",
          arguments: {},
        }),
        toolCall("mcp-call", "tool_call", {
          id: "mcp:fixture:find_issue",
          arguments: { query: "BTCC" },
        }),
      ]),
      (request) => {
        initialNames = request.tools.map((tool) => tool.name);
        const results = fixture.stores.guidedToolJournal.list(turn.turnId)
          .map((entry) => entry.result);
        [automationSearch, mcpSearch, descriptions, automationList, capabilityList,
          mcpCapabilities, mcpResource, memoryQuery, usageMonitor, mcpCall] = results;
        return { text: "현재 R3에서 실행 가능한 도구 범위를 확인했습니다.", toolCalls: [] };
      },
    ]));

    await agent.run({
      turn,
      signal: new AbortController().signal,
    });

    for (const name of [
      "list_automations",
      "list_mcp_capabilities",
      "read_mcp_resource",
      "query_memory",
      "get_usage_monitor",
    ]) {
      expect(initialNames).not.toContain(name);
    }

    const automationResults = (
      automationSearch as {
        results: Array<{
          name: string;
          enabled: boolean;
          disabled_reason: string | null;
        }>;
      }
    ).results;
    expect(automationResults.find((item) => item.name === "list_automations"))
      .toEqual(expect.objectContaining({
        enabled: true,
        disabled_reason: null,
      }));
    for (const name of [
      "create_automation",
      "delete_automation",
      "run_due_automations",
    ]) {
      expect(automationResults.find((item) => item.name === name))
        .toEqual(expect.objectContaining({
          enabled: false,
          disabled_reason: expect.stringContaining(
            "does not yet have a typed automation effect adapter",
          ),
        }));
    }

    expect(
      (mcpSearch as {
        results: Array<{
          id: string;
          enabled: boolean;
          disabled_reason: string | null;
        }>;
      }).results,
    ).toContainEqual(expect.objectContaining({
      id: "mcp:fixture:find_issue",
      enabled: false,
      disabled_reason: expect.stringContaining(
        "does not yet have a guarded MCP effect adapter",
      ),
    }));

    const byId = new Map(
      (descriptions as {
        descriptions: Array<{
          id: string;
          enabled: boolean;
          disabled_reason: string | null;
        }>;
      }).descriptions.map((item) => [item.id, item]),
    );
    expect(byId.get("native:list_automations")?.enabled).toBe(true);
    expect(byId.get("native:list_mcp_capabilities")?.enabled).toBe(true);
    expect(byId.get("native:read_mcp_resource")?.enabled).toBe(true);
    expect(byId.get("native:query_memory")?.enabled).toBe(true);
    expect(byId.get("native:get_usage_monitor")?.enabled).toBe(true);
    expect(byId.get("native:create_automation")).toEqual(
      expect.objectContaining({
        enabled: false,
        disabled_reason: expect.stringContaining(
          "does not yet have a typed automation effect adapter",
        ),
      }),
    );
    expect(byId.get("native:call_mcp_tool")).toEqual(expect.objectContaining({
      enabled: false,
      disabled_reason: expect.stringContaining(
        "does not yet have a guarded MCP effect adapter",
      ),
    }));
    expect(byId.get("mcp:fixture:find_issue")).toEqual(expect.objectContaining({
      enabled: false,
      disabled_reason: expect.stringContaining(
        "does not yet have a guarded MCP effect adapter",
      ),
    }));
    expect(automationList).toMatchObject({
      ok: true,
      automations: [],
    });
    const capabilityByName = new Map(
      (capabilityList as {
        capabilities: Array<{
          name: string;
          enabled: boolean;
          current_turn_callable: boolean;
          disabled_reason: string | null;
        }>;
      }).capabilities.map((item) => [item.name, item]),
    );
    expect(capabilityByName.get("list_automations")).toEqual(
      expect.objectContaining({
        enabled: true,
        current_turn_callable: true,
      }),
    );
    expect(capabilityByName.get("create_automation")).toEqual(
      expect.objectContaining({
        enabled: false,
        current_turn_callable: false,
        disabled_reason: expect.stringContaining(
          "does not yet have a typed automation effect adapter",
        ),
      }),
    );
    expect(capabilityByName.get("call_mcp_tool")).toEqual(
      expect.objectContaining({
        enabled: false,
        current_turn_callable: false,
        disabled_reason: expect.stringContaining(
          "does not yet have a guarded MCP effect adapter",
        ),
      }),
    );
    expect(mcpCapabilities).toMatchObject({
      ok: true,
      servers: [
        {
          id: "fixture",
          ok: true,
        },
      ],
    });
    expect(mcpResource).toMatchObject({
      ok: true,
      server_id: "fixture",
      uri: "butler://fixture",
    });
    expect(JSON.stringify(mcpResource)).toContain("fixture");
    expect(memoryQuery).toMatchObject({ ok: true });
    expect(usageMonitor).toMatchObject({ ok: true });
    expect(mcpCall).toMatchObject({
      ok: false,
      error: {
        code: "disabled_tool",
        message: expect.stringContaining(
          "does not yet have a guarded MCP effect adapter",
        ),
      },
    });
  } finally {
    fixture.close();
  }
});

test("flag-off Guided discovery and capability lists preserve the prior surface", async () => {
  const fixture = createFixture("guided-exact-replay-off-discovery");
  const previous = process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
  const previousSurface = process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE;
  delete process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
  process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = "on";
  try {
    const turn = turnRecord(fixture.root, { trackingMode: "none" });
    turn.context.executionPolicy!.requiredNativeTools = ["list_tool_capabilities"];
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        expect(request.tools.map((tool) => tool.name))
          .not.toContain("read_operation_results");
        expect(request.tools.map((tool) => tool.name))
          .toContain("list_tool_capabilities");
        return toolResponse([
        toolCall("search-exact", "tool_search", {
          query: "read_operation_results", include_disabled: true,
        }),
        toolCall("describe-exact", "tool_describe", {
          ids: ["native:read_operation_results"],
        }),
        toolCall("capabilities", "list_tool_capabilities", {
          include_disabled: true,
        }),
        ]);
      },
      (request) => {
        const messages = messagesWithToolResults(request);
        const result = toolMessageOutput(messages
          .find((message) => message.toolCallId === "search-exact")) as {
            results?: Array<{ name: string }>;
          };
        expect(result.results?.map((entry) => entry.name) ?? [])
          .not.toContain("read_operation_results");
        expect(toolMessageOutput(messages.find((message) =>
          message.toolCallId === "describe-exact"))).toMatchObject({
            ok: false,
            descriptions: [],
            missing: [{
              id: "native:read_operation_results",
              error: "unknown_tool_catalog_id",
            }],
          });
        const capabilityResult = toolMessageOutput(messages.find((message) =>
          message.toolCallId === "capabilities")) as {
            ok?: boolean;
            current_turn_surface_known?: boolean;
            capabilities?: Array<{ name: string }>;
          };
        expect(capabilityResult).toMatchObject({
          ok: true,
          current_turn_surface_known: true,
        });
        expect(capabilityResult.capabilities?.map((entry) => entry.name) ?? [])
          .not.toContain("read_operation_results");
        expect(JSON.stringify(capabilityResult))
          .not.toContain("read_operation_results");
        return { text: "exact replay remains disabled", toolCalls: [] };
      },
    ]));
    const output = await agent.run({
      turn,
      signal: new AbortController().signal,
    });
    expect(output.content).toBe("exact replay remains disabled");
  } finally {
    if (previous === undefined) delete process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
    else process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = previous;
    if (previousSurface === undefined) delete process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE;
    else process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = previousSurface;
    fixture.close();
  }
});

test("flag-on Guided capability list exposes the canonical exact reader as callable", async () => {
  const fixture = createFixture("guided-exact-replay-on-capabilities");
  const previous = process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
  const previousSurface = process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE;
  process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = "on";
  process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = "on";
  try {
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        expect(request.tools.map((tool) => tool.name))
          .toContain("read_operation_results");
        expect(request.tools.map((tool) => tool.name))
          .toContain("list_tool_capabilities");
        return toolResponse([toolCall("capabilities", "list_tool_capabilities", {
          include_disabled: true,
        })]);
      },
      (request) => {
        const result = toolMessageOutput(messagesWithToolResults(request)
          .find((message) => message.toolCallId === "capabilities")) as {
            capabilities?: Array<{
              name: string;
              enabled: boolean;
              current_turn_selected: boolean;
              current_turn_callable: boolean;
            }>;
          };
        const exact = result.capabilities?.filter((entry) =>
          entry.name === "read_operation_results");
        expect(exact).toEqual([expect.objectContaining({
          enabled: true,
          current_turn_selected: true,
          current_turn_callable: true,
        })]);
        return { text: "canonical exact reader is callable", toolCalls: [] };
      },
    ]));
    const turn = turnRecord(fixture.root, {
      accessMode: "full_access", trackingMode: "local",
    });
    turn.context.executionPolicy!.requiredNativeTools = ["list_tool_capabilities"];
    turn.modelRoute = buildModelRoute({
      primaryModelRef: "openai/gpt-5.6-sol", backupModelRefs: [],
      reasoningEffort: "low", catalogGeneration: "test",
    });
    const output = await agent.run({
      turn,
      signal: new AbortController().signal,
      recordModelRoundAcceptance: async () => {},
      loadModelRoundAcceptance: async () => undefined,
    });
    expect(output.content).toBe("canonical exact reader is callable");
  } finally {
    if (previous === undefined) delete process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
    else process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = previous;
    if (previousSurface === undefined) delete process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE;
    else process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = previousSurface;
    fixture.close();
  }
});

test("flag-off required exact capability fails before Guided provider dispatch", async () => {
  const fixture = createFixture("guided-exact-replay-off-required");
  const previous = process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
  delete process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
  let calls = 0;
  try {
    const agent = fixture.agent({ async runRound() {
      calls += 1;
      return { text: "must not dispatch", toolCalls: [] };
    } });
    const turn = turnRecord(fixture.root, { accessMode: "full_access" });
    turn.context.executionPolicy!.requiredNativeTools = ["read_operation_results"];
    await expect(agent.run({ turn, signal: new AbortController().signal }))
      .rejects.toThrow("required tool is unavailable while exact replay is disabled");
    expect(calls).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY;
    else process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = previous;
    fixture.close();
  }
});

test("Guided replay keeps native read-only MCP and automation tools retryable", () => {
  for (const name of [
    "bind_session_git_worktree",
    "list_automations",
    "list_mcp_capabilities",
    "read_mcp_resource",
    "list_tool_capabilities",
  ]) {
    expect(isReplaySafeTool(name)).toBe(true);
  }
  expect(isReplaySafeTool("create_automation")).toBe(false);
  expect(isReplaySafeTool("call_mcp_tool")).toBe(false);
  expect(isReplaySafeTool("transform_public_data_table")).toBe(false);
});

test("direct and tool_call file mutations use the same reviewed effect gate", async () => {
  const fixture = createFixture("guided-effect-bridge");
  try {
    let direct: unknown;
    let bridged: unknown;
    const turnId = "turn-effect-bridge";
    const agent = fixture.agent(scriptedModelRound([
      toolResponse([
        toolCall("direct-1", "write_file", {
          path: "direct.txt",
          content: "blocked",
        }),
        toolCall("bridged-1", "tool_call", {
          id: "native:write_file",
          arguments: {
            path: "bridged.txt",
            content: "blocked",
          },
        }),
      ]),
      (request) => {
        const results = fixture.stores.guidedToolJournal.list(turnId)
          .map((entry) => entry.result);
        [direct, bridged] = results;
        expect(messagesWithToolResults(request)).toHaveLength(2);
        return {
          text: "검토된 Plan이 없어 파일을 변경하지 않았습니다.",
          toolCalls: [],
        };
      },
    ]));

    await agent.run({
      turn: turnRecord(fixture.root, { turnId }),
      signal: new AbortController().signal,
    });

    expect(direct).toMatchObject({
      ok: false,
      error: { code: "effect_work_required" },
    });
    expect(bridged).toMatchObject({
      ok: false,
      error: { code: "effect_work_required" },
      bridge_invocation: { id: "native:write_file" },
    });
    expect(existsSync(join(fixture.root, "direct.txt"))).toBe(false);
    expect(existsSync(join(fixture.root, "bridged.txt"))).toBe(false);
  } finally {
    fixture.close();
  }
});

test("Guided catalog and tool_call execute the same simple write_file contract", async () => {
  const fixture = createFixture("guided-write-file-bridge");
  try {
    let description: unknown;
    let writeResult: unknown;
    const turnId = "turn-guided-write-file-bridge";
    const calls = [
      toolCall("plan-1", "replace_work_plan", {
        objective: "Create bridged.txt",
        actions: [{
          action_key: "write-bridged-file",
          description: "Write the requested file",
          effect: {
            capability: "write_file",
            target: "workspace:bridged.txt",
          },
        }],
        checks: ["bridged.txt contains the requested content"],
      }),
      toolCall("plan-review-1", "record_work_review", {
        subject: "plan",
        verdict: "accept",
        summary: "The plan directly creates the requested file.",
      }),
      toolCall("describe-1", "tool_describe", {
        ids: ["native:write_file"],
      }),
      toolCall("write-1", "tool_call", {
        id: "native:write_file",
        arguments: {
          path: "bridged.txt",
          content: "bridge contract works\n",
        },
      }),
      toolCall("result-review-1", "record_work_review", {
        subject: "result",
        verdict: "accept",
        summary: "The requested file was written with the exact content.",
      }),
    ];
    const agent = fixture.agent(scriptedModelRound([
      toolResponse(calls),
      (request) => {
        const results = fixture.stores.guidedToolJournal.list(turnId)
          .map((entry) => entry.result);
        description = results[2];
        writeResult = results[3];
        expect(messagesWithToolResults(request)).toHaveLength(calls.length);
        return { text: "브리지 경로로 파일을 작성했습니다.", toolCalls: [] };
      },
    ]));
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    expect(await runtime.runTurn(localRunCommand(fixture.root, turnId)))
      .toMatchObject({
        kind: "delivered",
        content: "브리지 경로로 파일을 작성했습니다.",
      });

    const encodedDescription = JSON.stringify(description);
    expect(encodedDescription).not.toContain("expected_sha256");
    expect(encodedDescription).not.toContain("overwrite");
    expect(description).toMatchObject({
      ok: true,
      descriptions: [{
        id: "native:write_file",
        enabled: true,
        schema: { required: ["path", "content"] },
      }],
    });
    expect(writeResult).toMatchObject({
      ok: true,
      effect_receipt: {
        capability: "write_file",
        target: "workspace:bridged.txt",
      },
      bridge_invocation: { id: "native:write_file" },
    });
    expect(readFileSync(join(fixture.root, "bridged.txt"), "utf8"))
      .toBe("bridge contract works\n");
    expect((await fixture.stores.turns.findTurn(turnId))?.route).toBe("managed");
  } finally {
    fixture.close();
  }
});

test("Guided agent applies a small edit through the reviewed durable effect", async () => {
  const fixture = createFixture("guided-edit-file");
  try {
    writeFileSync(
      join(fixture.root, "styles.css"),
      "body {\n  overflow-x: auto;\n}\n",
    );
    const results: unknown[] = [];
    let editResult: unknown;
    const turnId = "turn-guided-edit-file";
    const calls = [
      toolCall("plan-1", "replace_work_plan", {
        objective: "Correct the visible horizontal overflow",
        actions: [{
          action_key: "correct-style",
          description: "Make the requested contained workspace correction",
          effect: {
            capability: "workspace mutation",
            target: "workspace:requested-source-change",
          },
        }],
        checks: ["The resulting stylesheet contains the requested correction"],
      }),
      toolCall("plan-review-1", "record_work_review", {
        subject: "plan",
        verdict: "accept",
        summary: "The small contained correction matches the request.",
      }),
      toolCall("edit-1", "edit_file", {
        path: "styles.css",
        start_line: 2,
        old_text: "  overflow-x: auto;\n",
        new_text: "  overflow-x: hidden;\n",
      }),
      toolCall("checkpoint-1", "record_work_checkpoint", {
        action_updates: [{
          action_key: "correct-style",
          status: "done",
        }],
        public_summary: "The requested stylesheet correction is present.",
        next_step: "Review the corrected stylesheet.",
      }),
      toolCall("result-review-1", "record_work_review", {
        subject: "result",
        verdict: "accept",
        summary: "The requested stylesheet correction is present.",
      }),
      toolCall("completion-1", "record_work_review", {
        subject: "completion",
        verdict: "accept",
        next_stage: "reporting",
        summary: "The whole Work satisfies the requested stylesheet correction.",
      }),
    ];
    const agent = fixture.agent(scriptedModelRound([
      toolResponse(calls),
      (request) => {
        results.push(...fixture.stores.guidedToolJournal.list(turnId)
          .map((entry) => entry.result));
        const messages = messagesWithToolResults(request);
        editResult = toolMessageOutput(
          messages.find((message) => message.toolCallId === "edit-1"),
        );
        expect(messages).toHaveLength(calls.length);
        return { text: "가로 넘침 수정을 완료했습니다.", toolCalls: [] };
      },
    ]));
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    expect(await runtime.runTurn(localRunCommand(fixture.root, turnId)))
      .toMatchObject({
      kind: "delivered",
      content: "가로 넘침 수정을 완료했습니다.",
    });
    for (const result of results) expect(result).toMatchObject({ ok: true });
    expect(editResult).toMatchObject({
      ok: true,
      start_line: 2,
      effect_receipt: {
        capability: "edit_file",
        target: "workspace:styles.css",
        start_line: 2,
      },
    });
    expect(readFileSync(join(fixture.root, "styles.css"), "utf8"))
      .toBe("body {\n  overflow-x: hidden;\n}\n");
    const work = await fixture.stores.durableWork.boundWorkForTurn(turnId);
    expect(work?.status).toBe("completed");
    expect(work?.latestCompletionValidation?.verdict).toBe("accept");
    expect(fixture.stores.guidedEffectJournal.listForWork(work!.workId))
      .toEqual([
        expect.objectContaining({
          capability: "edit_file",
          sanitizedTarget: "workspace:styles.css",
          status: "applied",
        }),
      ]);
    expect((await fixture.stores.turns.findTurn(turnId))?.route).toBe("managed");
  } finally {
    fixture.close();
  }
});

test("reviewed run_command mutation records a receipt and pushes without force", async () => {
  const fixture = createFixture("guided-command-effect");
  try {
    const workspace = join(fixture.root, "workspace");
    const remote = join(fixture.root, "remote.git");
    mkdirSync(workspace, { recursive: true });
    runGit(["init", "-b", "main"], workspace);
    runGit(["init", "--bare", remote], fixture.root);
    runGit(["remote", "add", "origin", remote], workspace);
    writeFileSync(join(workspace, "deliverable.txt"), "reviewed command effect\n");

    let beforeWork: unknown;
    let beforeReview: unknown;
    let pushed: unknown;
    let nonzero: unknown;
    const turnId = "turn-guided-command-effect";
    const calls = [
      toolCall("before-work-1", "run_command", {
        command: "printf blocked > before-work.txt",
        summary: "Plan 검토 전 변경 차단을 확인합니다.",
        state_effect: "mutation",
      }),
      toolCall("plan-1", "replace_work_plan", {
        objective: "Commit and publish the requested contained workspace result",
        actions: [{
          action_key: "publish-result",
          description: "Commit the requested result and publish it to the configured remote",
          effect: {
            capability: "workspace mutation",
            target: "workspace:reviewed-command-result",
          },
        }],
        checks: ["The commit exists on the configured non-force remote branch"],
      }),
      toolCall("before-review-1", "run_command", {
        command: "printf blocked > before-review.txt",
        summary: "Plan 검토 전 변경 차단을 확인합니다.",
        state_effect: "mutation",
      }),
      toolCall("plan-review-1", "record_work_review", {
        subject: "plan",
        verdict: "accept",
        summary: "The contained Git command directly produces the requested result.",
        next_stage: "execution",
      }),
      toolCall("push-1", "run_command", {
        command: [
          "git add deliverable.txt",
          "git -c user.name=Butler -c user.email=butler@example.invalid commit -m reviewed-command-effect",
          "git push origin HEAD:main",
        ].join(" && "),
        summary: "검토된 결과를 원격 main 브랜치에 게시합니다.",
        state_effect: "mutation",
      }),
      toolCall("nonzero-1", "run_command", {
        command: "printf partial > command-failed.txt; exit 7",
        summary: "실패한 명령의 부분 결과를 확인합니다.",
        state_effect: "mutation",
      }),
    ];
    const agent = fixture.agent(scriptedModelRound([
      toolResponse(calls),
      (request) => {
        const results = fixture.stores.guidedToolJournal.list(turnId)
          .map((entry) => entry.result);
        [beforeWork, , beforeReview, , pushed, nonzero] = results;
        expect(messagesWithToolResults(request)).toHaveLength(calls.length);
        return { text: "검토된 명령 실행 결과를 보고합니다.", toolCalls: [] };
      },
    ]));
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });

    expect(await runtime.runTurn(localRunCommand(workspace, turnId)))
      .toMatchObject({ kind: "delivered" });
    expect(beforeWork).toMatchObject({
      ok: false,
      error: { code: "effect_work_required", recoverable: true },
    });
    expect(beforeReview).toMatchObject({
      ok: false,
      error: { code: "effect_plan_review_required", recoverable: true },
    });
    expect(existsSync(join(workspace, "before-work.txt"))).toBe(false);
    expect(existsSync(join(workspace, "before-review.txt"))).toBe(false);
    expect(pushed).toMatchObject({
      ok: true,
      exit_code: 0,
      sandbox: "full_access_contained",
      effect_receipt: {
        capability: "run_command",
        target: "workspace-command:.",
      },
    });
    expect(nonzero).toMatchObject({
      ok: false,
      exit_code: 7,
      command_outcome_observed: true,
      effect_receipt: { capability: "run_command" },
    });
    expect(readFileSync(join(workspace, "command-failed.txt"), "utf8"))
      .toBe("partial");
    expect(runGit(["rev-parse", "refs/heads/main"], remote, true))
      .toMatch(/^[a-f0-9]{40}$/u);
    const work = await fixture.stores.durableWork.boundWorkForTurn(turnId);
    expect(fixture.stores.guidedEffectJournal.listForWork(work!.workId))
      .toEqual([
        expect.objectContaining({ capability: "run_command", status: "applied" }),
        expect.objectContaining({ capability: "run_command", status: "applied" }),
      ]);
  } finally {
    fixture.close();
  }
});

test("Guided agent renders CSV text once and passes image attachments to the provider", async () => {
  const fixture = createFixture("guided-attachments");
  try {
    const csvPath = join(fixture.root, "products.csv");
    const imagePath = join(fixture.root, "photo.png");
    writeFileSync(csvPath, "name,pork_percent\nA,91\nB,82\n");
    writeFileSync(imagePath, "not-a-real-image");
    let prompt = "";
    let attachments: unknown[] = [];
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        prompt = request.messages[0]?.content ?? "";
        attachments = [...(request.attachments ?? [])];
        return { text: "분석했습니다.", toolCalls: [] };
      },
    ]));
    const turn = turnRecord(fixture.root, {
      attachments: [{
        id: "csv-1",
        kind: "document",
        mimeType: "text/csv",
        fileName: "products.csv",
        localPath: csvPath,
      }, {
        id: "image-1",
        kind: "image",
        mimeType: "image/png",
        fileName: "photo.png",
        localPath: imagePath,
      }],
    });

    await agent.run({ turn, signal: new AbortController().signal });

    expect(prompt.match(/name,pork_percent/g)?.length).toBe(1);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      id: "guided-image:image-1",
      kind: "image",
      localPath: imagePath,
    });
  } finally {
    fixture.close();
  }
});

test("Guided agent offers only the three optional R3 Work tools and keeps direct turns free of Work", async () => {
  const fixture = createFixture("guided-work-surface");
  try {
    let visibleNames: string[] = [];
    const turn = turnRecord(fixture.root, {
      turnId: "turn-direct-with-work-available",
      trackingMode: "local",
    });
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        visibleNames = request.tools.map((tool) => tool.name);
        return { text: "안녕하세요.", toolCalls: [] };
      },
    ]));

    const outcome = await agent.run({
      turn,
      signal: new AbortController().signal,
    });

    expect(visibleNames).toContain("replace_work_plan");
    expect(visibleNames).toContain("record_work_checkpoint");
    expect(visibleNames).toContain("record_work_review");
    expect(visibleNames).not.toContain("update_todo_list");
    expect(visibleNames).not.toContain("list_todo_list");
    expect(visibleNames).not.toContain("list_work_streams");
    expect(visibleNames).not.toContain("update_work_stream_state");
    expect(outcome.route).toBe("direct");
    expect(await fixture.stores.durableWork.boundWorkForTurn(turn.turnId)).toBeNull();
  } finally {
    fixture.close();
  }
});

test("Guided tool discovery hides the retired R2 Work catalog", async () => {
  const fixture = createFixture("guided-work-catalog");
  try {
    let searchResult: unknown;
    let describeResult: unknown;
    const turnId = "turn-work-catalog";
    const calls = [
      toolCall("search-1", "tool_search", {
        query: "work",
        include_disabled: true,
      }),
      toolCall("describe-1", "tool_describe", {
        ids: ["native:list_work_streams", "native:control_work"],
      }),
    ];
    const agent = fixture.agent(scriptedModelRound([
      toolResponse(calls),
      (request) => {
        const records = fixture.stores.guidedToolJournal.list(turnId);
        searchResult = records.find((entry) => entry.toolName === "tool_search")?.result;
        describeResult = records.find((entry) => entry.toolName === "tool_describe")?.result;
        expect(messagesWithToolResults(request)).toHaveLength(calls.length);
        return { text: "현재 작업 도구를 확인했습니다.", toolCalls: [] };
      },
    ]));

    await agent.run({
      turn: turnRecord(fixture.root, {
        turnId,
        trackingMode: "local",
      }),
      signal: new AbortController().signal,
    });

    const encodedSearch = JSON.stringify(searchResult);
    expect(encodedSearch).not.toContain("list_work_streams");
    expect(encodedSearch).not.toContain("update_work_stream_state");
    expect(encodedSearch).not.toContain("control_work");
    expect(encodedSearch).not.toContain("project_ledger_work_update");
    expect(encodedSearch).not.toContain("project_ledger_work_complete");
    expect(encodedSearch).not.toContain("complete_project_work");
    expect(describeResult).toMatchObject({
      ok: false,
      descriptions: [],
      missing: [
        { id: "native:list_work_streams", error: "unknown_tool_catalog_id" },
        { id: "native:control_work", error: "unknown_tool_catalog_id" },
      ],
    });
  } finally {
    fixture.close();
  }
});

test("Guided agent replays completed tool results and fences uncertain mutations", async () => {
  const fixture = createFixture("guided-replay");
  try {
    const factPath = join(fixture.root, "fact.txt");
    writeFileSync(factPath, "first value");
    const turn = turnRecord(fixture.root, { turnId: "turn-read-replay" });
    const outputs: unknown[] = [];
    const runRead = async () => {
      const agent = fixture.agent(scriptedModelRound([
        toolResponse([toolCall("read-1", "read_file", { path: "fact.txt" })]),
        (request) => {
          outputs.push(fixture.stores.guidedToolJournal.list(turn.turnId)[0]?.result);
          expect(messagesWithToolResults(request)).toHaveLength(1);
          return { text: "읽었습니다.", toolCalls: [] };
        },
      ]));
      return agent.run({ turn, signal: new AbortController().signal });
    };
    await runRead();
    writeFileSync(factPath, "second value");
    await runRead();
    expect(outputs[1]).toEqual(outputs[0]);
    expect(JSON.stringify(outputs[1])).toContain("first value");
    expect(fixture.stores.guidedToolJournal.list(turn.turnId)).toHaveLength(1);

    const mutationTurn = turnRecord(fixture.root, { turnId: "turn-uncertain-mutation" });
    const mutationArgs = {
      path: "out.txt",
      content: "durable output",
    };
    const rawMutation = JSON.stringify(mutationArgs);
    const callId = digest([
      "btcc-guided-provider-tool-call.v1",
      mutationTurn.turnId,
      "mutation-1",
      "write_file",
      stableJson(mutationArgs),
    ].join("\0"));
    fixture.stores.guidedToolJournal.start({
      turnId: mutationTurn.turnId,
      callId,
      toolName: "write_file",
      rawArguments: rawMutation,
      arguments: mutationArgs,
    });
    let uncertain: unknown;
    const mutationAgent = fixture.agent(scriptedModelRound([
      toolResponse([toolCall("mutation-1", "write_file", mutationArgs)]),
      (request) => {
        const messages = messagesWithToolResults(request);
        uncertain = toolMessageOutput(
          messages.find((message) => message.toolCallId === "mutation-1"),
        );
        expect(messages).toHaveLength(1);
        return { text: "상태를 먼저 확인해야 합니다.", toolCalls: [] };
      },
    ]));
    const outcome = await mutationAgent.run({
      turn: mutationTurn,
      signal: new AbortController().signal,
    });
    expect(uncertain).toMatchObject({
      ok: false,
      error: { code: "effect_work_required" },
    });
    expect(existsSync(join(fixture.root, "out.txt"))).toBe(false);
    expect(outcome.route).toBe("assisted");
  } finally {
    fixture.close();
  }
});

test("Guided tool restart reuses a prestarted occurrence after call order changes", async () => {
  const fixture = createFixture("guided-restart-call-order");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "turn-restart-call-order",
    });
    const writeArgs = {
      path: "out.txt",
      content: "durable output",
      overwrite: false,
    };
    const rawWrite = JSON.stringify(writeArgs);
    const prestartedCallId = digest([
      "btcc-guided-tool-call.v1",
      turn.turnId,
      "0",
      "write_file",
      stableJson(writeArgs),
    ].join("\0"));
    fixture.stores.guidedToolJournal.start({
      turnId: turn.turnId,
      callId: prestartedCallId,
      toolName: "write_file",
      rawArguments: rawWrite,
      arguments: writeArgs,
    });

    const occurrences: Array<{ toolName: string; occurrenceId?: string }> = [];
    const toolCalls = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      workScope: {
        turnId: turn.turnId,
        sessionId: turn.sessionId,
      },
      authorizedNames: new Set(["grep_files", "write_file"]),
      visibleNames: new Set(["grep_files", "write_file"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      executeButlerTool: async (call, context) => {
        occurrences.push({
          toolName: call.name,
          occurrenceId: context?.effectOccurrenceId,
        });
        return { ok: true, tool: call.name };
      },
    });

    await toolCalls.executeTool({
      name: "grep_files",
      args: { query: "fact", path: "." },
      rawArguments: JSON.stringify({ query: "fact", path: "." }),
    });
    await toolCalls.executeTool({
      name: "write_file",
      args: {
        overwrite: false,
        content: "durable output",
        path: "out.txt",
      },
      rawArguments:
        '{ "overwrite": false, "content": "durable output", "path": "out.txt" }',
    });
    await toolCalls.executeTool({
      name: "write_file",
      args: writeArgs,
      rawArguments: rawWrite,
    });

    const reorderedCallId = digest([
      "btcc-guided-tool-call.v1",
      turn.turnId,
      "1",
      "write_file",
      stableJson(writeArgs),
    ].join("\0"));
    const newOccurrenceCallId = digest([
      "btcc-guided-tool-call.v1",
      turn.turnId,
      "2",
      "write_file",
      stableJson(writeArgs),
    ].join("\0"));
    expect(occurrences[1]).toEqual({
      toolName: "write_file",
      occurrenceId: prestartedCallId,
    });
    expect(occurrences[2]).toEqual({
      toolName: "write_file",
      occurrenceId: newOccurrenceCallId,
    });
    expect(fixture.stores.guidedToolJournal.find(prestartedCallId)?.status)
      .toBe("completed");
    expect(fixture.stores.guidedToolJournal.find(reorderedCallId)).toBeNull();
    expect(fixture.stores.guidedToolJournal.find(newOccurrenceCallId)?.status)
      .toBe("completed");
  } finally {
    fixture.close();
  }
});

test("provider call identity replays one occurrence but admits an identical new command", async () => {
  const fixture = createFixture("guided-provider-occurrence");
  try {
    const occurrences: string[] = [];
    const mutationArgs = {
      command: "printf reviewed >> result.txt",
      summary: "검토된 결과를 작업공간에 기록합니다.",
      state_effect: "mutation",
    };
    const firstTurn = turnRecord(fixture.root, {
      turnId: "guided-provider-occurrence-turn-1",
    });
    const secondTurn = turnRecord(fixture.root, {
      turnId: "guided-provider-occurrence-turn-2",
    });
    const createExecutor = (turn: TurnRecord) => createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["run_command"]),
      visibleNames: new Set(["run_command"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      executeButlerTool: async (_call, context) => {
        if (!context?.effectOccurrenceId) {
          throw new Error("Expected a runtime-owned effect occurrence");
        }
        occurrences.push(context.effectOccurrenceId);
        return { ok: true, dispatched: true };
      },
    });
    const execute = (
      executor: ReturnType<typeof createGuidedToolCallExecutor>,
      providerCallId: string,
    ) => executor.executeTool({
      name: "run_command",
      args: mutationArgs,
      rawArguments: JSON.stringify(mutationArgs),
      providerCallId,
    });

    await execute(createExecutor(firstTurn), "provider-call-original");
    expect(occurrences).toHaveLength(1);
    const originalOccurrence = occurrences[0];

    const replayed = await execute(
      createExecutor(firstTurn),
      "provider-call-original",
    );
    expect(replayed).toMatchObject({ ok: true, dispatched: true });
    expect(occurrences).toEqual([originalOccurrence!]);

    await execute(createExecutor(firstTurn), "provider-call-new");
    await execute(createExecutor(secondTurn), "provider-call-original");
    expect(occurrences).toHaveLength(3);
    expect(new Set(occurrences).size).toBe(3);
    expect(fixture.stores.guidedToolJournal.list(firstTurn.turnId)).toHaveLength(2);
    expect(fixture.stores.guidedToolJournal.list(secondTurn.turnId)).toHaveLength(1);
  } finally {
    fixture.close();
  }
});

test("provider v1 progressive mutation records remain authoritative across the identity migration", async () => {
  const fixture = createFixture("guided-provider-v1-progressive-replay");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-provider-v1-progressive-replay-turn",
    });
    const summarylessMutationArgs = {
      command: "printf reviewed >> result.txt",
      state_effect: "mutation",
    };
    const mutationArgs = {
      ...summarylessMutationArgs,
      summary: "검토된 결과를 작업공간에 기록합니다.",
    };
    const calls = [
      { providerCallId: "provider-v1-completed", result: { ok: true, completed: true } },
      { providerCallId: "provider-v1-started" },
    ] as const;
    for (const call of calls) {
      const rawArgs = {
        id: "native:run_command",
        arguments: summarylessMutationArgs,
      };
      const callId = digest([
        "btcc-guided-provider-tool-call.v1",
        turn.turnId,
        call.providerCallId,
        "tool_call",
        stableJson(rawArgs),
      ].join("\0"));
      fixture.stores.guidedToolJournal.start({
        turnId: turn.turnId,
        callId,
        toolName: "run_command",
        rawArguments: JSON.stringify(rawArgs),
        arguments: summarylessMutationArgs,
      });
      if ("result" in call) {
        fixture.stores.guidedToolJournal.finish({
          callId,
          status: "completed",
          result: call.result,
        });
      }
    }

    const effectOccurrences: string[] = [];
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["tool_call"]),
      visibleNames: new Set(["tool_call"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      executeButlerTool: async (_call, context) => {
        effectOccurrences.push(context?.effectOccurrenceId ?? "");
        return { ok: true, resumed: true };
      },
    });
    const execute = (providerCallId: string) => executor.executeTool({
      name: "tool_call",
      args: {
        id: "native:run_command",
        arguments: mutationArgs,
      },
      rawArguments: JSON.stringify({
        id: "native:run_command",
        arguments: mutationArgs,
      }),
      providerCallId,
    });

    await expect(execute("provider-v1-completed")).resolves.toEqual({
      ok: true,
      completed: true,
    });
    await expect(execute("provider-v1-started")).resolves.toEqual({
      ok: true,
      resumed: true,
    });
    expect(effectOccurrences).toHaveLength(1);
    expect(effectOccurrences[0]).toBe(
      digest([
        "btcc-guided-provider-tool-call.v1",
        turn.turnId,
        "provider-v1-started",
        "tool_call",
        stableJson({ id: "native:run_command", arguments: summarylessMutationArgs }),
      ].join("\0")),
    );
  } finally {
    fixture.close();
  }
});

test("summaryless provider v1 responses replay without public activity or duplicate dispatch", async () => {
  const fixture = createFixture("guided-provider-v1-summaryless-replay");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-provider-v1-summaryless-replay-turn",
    });
    const summarylessArgs = {
      command: "printf reviewed >> result.txt",
      state_effect: "mutation",
    };
    const calls = [
      { providerCallId: "provider-summaryless-completed", result: { ok: true, completed: true } },
      { providerCallId: "provider-summaryless-started" },
    ] as const;
    const oldCallIds = new Map<string, string>();
    for (const call of calls) {
      const rawArgs = {
        id: "native:run_command",
        arguments: summarylessArgs,
      };
      const callId = digest([
        "btcc-guided-provider-tool-call.v1",
        turn.turnId,
        call.providerCallId,
        "tool_call",
        stableJson(rawArgs),
      ].join("\0"));
      oldCallIds.set(call.providerCallId, callId);
      fixture.stores.guidedToolJournal.start({
        turnId: turn.turnId,
        callId,
        toolName: "run_command",
        rawArguments: JSON.stringify(rawArgs),
        arguments: summarylessArgs,
      });
      if ("result" in call) {
        fixture.stores.guidedToolJournal.finish({
          callId,
          status: "completed",
          result: call.result,
        });
      }
    }

    const operations: string[] = [];
    const effectOccurrences: string[] = [];
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      progress: {
        stateChanged: async () => {},
        operationChanged: async (update) => {
          operations.push(update.status);
        },
      },
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["tool_call"]),
      visibleNames: new Set(["tool_call"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      executeButlerTool: async (_call, context) => {
        effectOccurrences.push(context?.effectOccurrenceId ?? "");
        return { ok: true, resumed: true };
      },
    });
    const execute = (providerCallId: string) => executor.executeTool({
      name: "tool_call",
      args: {
        id: "native:run_command",
        arguments: summarylessArgs,
      },
      rawArguments: JSON.stringify({
        id: "native:run_command",
        arguments: summarylessArgs,
      }),
      providerCallId,
    });

    await expect(execute("provider-summaryless-completed")).resolves.toEqual({
      ok: true,
      completed: true,
    });
    await expect(execute("provider-summaryless-started")).resolves.toEqual({
      ok: true,
      resumed: true,
    });
    expect(operations).toEqual([]);
    expect(effectOccurrences).toEqual([
      oldCallIds.get("provider-summaryless-started")!,
    ]);
    expect(fixture.stores.guidedToolJournal.list(turn.turnId)).toHaveLength(2);
    expect(fixture.stores.guidedToolJournal.find(
      oldCallIds.get("provider-summaryless-started")!,
    )?.status).toBe("completed");
  } finally {
    fixture.close();
  }
});

test("summaryless provider v1 started progressive replay crosses the real bridge schema", async () => {
  const fixture = createFixture("guided-provider-v1-progressive-schema-replay");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-provider-v1-progressive-schema-replay-turn",
    });
    const providerCallId = "provider-progressive-schema-replay";
    const summarylessArgs = {
      command: "printf reviewed >> result.txt",
      state_effect: "mutation",
    };
    const rawBridgeArgs = {
      id: "native:run_command",
      arguments: summarylessArgs,
    };
    const oldCallId = digest([
      "btcc-guided-provider-tool-call.v1",
      turn.turnId,
      providerCallId,
      "tool_call",
      stableJson(rawBridgeArgs),
    ].join("\0"));
    fixture.stores.guidedToolJournal.start({
      turnId: turn.turnId,
      callId: oldCallId,
      toolName: "run_command",
      rawArguments: JSON.stringify(rawBridgeArgs),
      arguments: summarylessArgs,
    });

    const operations: string[] = [];
    const dispatched: Array<{
      name: string;
      args: Record<string, unknown>;
      effectOccurrenceId?: string;
    }> = [];
    const bridge = createToolCallToolHandler({
      butlerData: fixture.root,
      currentToolNames: ["run_command"],
      nativeToolDefinitions: [runCommandToolDefinition],
      dispatchTool: async (call, context) => {
        dispatched.push({
          name: call.name,
          args: call.args,
          ...(context?.effectOccurrenceId
            ? { effectOccurrenceId: context.effectOccurrenceId }
            : {}),
        });
        return { ok: true, exit_code: 0 };
      },
    });
    const executeButlerTool: ContextualButlerToolExecutor = (call, context) =>
      bridge({ args: call.args, rawArguments: call.rawArguments }, context);
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      progress: {
        stateChanged: async () => {},
        operationChanged: async (update) => {
          operations.push(update.status);
        },
      },
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["tool_call"]),
      visibleNames: new Set(["tool_call"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      executeButlerTool,
    });

    const result = await executor.executeTool({
      name: "tool_call",
      args: rawBridgeArgs,
      rawArguments: JSON.stringify(rawBridgeArgs),
      providerCallId,
    });

    expect(result).toMatchObject({
      ok: true,
      exit_code: 0,
      bridge_invocation: {
        id: "native:run_command",
        provider: "native",
        affordance: "native_tool",
      },
    });
    expect(result).not.toHaveProperty("summary");
    expect(JSON.stringify(result)).not.toContain("previously started");
    expect(operations).toEqual([]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      name: "run_command",
      effectOccurrenceId: oldCallId,
      args: {
        command: summarylessArgs.command,
        state_effect: summarylessArgs.state_effect,
        summary: expect.any(String),
      },
    });
    expect(fixture.stores.guidedToolJournal.list(turn.turnId)).toHaveLength(1);
    expect(fixture.stores.guidedToolJournal.find(oldCallId)?.status)
      .toBe("completed");
  } finally {
    fixture.close();
  }
});

test("v2 exact records win when a provider v1 alias points at another replay", async () => {
  const fixture = createFixture("guided-provider-v2-v1-conflict");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-provider-v2-v1-conflict-turn",
    });
    const providerCallId = "provider-v2-v1-conflict";
    const args = {
      id: "native:run_command",
      arguments: {
        command: "pwd",
        summary: "현재 작업공간 위치를 확인합니다.",
        state_effect: "read_only",
      },
    };
    const exactCallId = guidedToolOccurrence({
      turnId: turn.turnId,
      callIndex: 0,
      providerCallId,
      name: "tool_call",
      args,
    }).callId;
    const legacyCallId = digest([
      "btcc-guided-provider-tool-call.v1",
      turn.turnId,
      providerCallId,
      "tool_call",
      stableJson(args),
    ].join("\0"));
    const legacyArgs = args.arguments;
    fixture.stores.guidedToolJournal.start({
      turnId: turn.turnId,
      callId: legacyCallId,
      toolName: "run_command",
      rawArguments: JSON.stringify(args),
      arguments: legacyArgs,
    });
    fixture.stores.guidedToolJournal.start({
      turnId: turn.turnId,
      callId: exactCallId,
      toolName: "run_command",
      rawArguments: JSON.stringify(args),
      arguments: legacyArgs,
    });
    fixture.stores.guidedToolJournal.finish({
      callId: exactCallId,
      status: "completed",
      result: { ok: true, source: "v2-exact" },
    });

    let dispatches = 0;
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["tool_call"]),
      visibleNames: new Set(["tool_call"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      executeButlerTool: async () => {
        dispatches += 1;
        return { ok: true, source: "dispatch" };
      },
    });

    await expect(executor.executeTool({
      name: "tool_call",
      args,
      rawArguments: JSON.stringify(args),
      providerCallId,
    })).resolves.toEqual({ ok: true, source: "v2-exact" });
    expect(dispatches).toBe(0);
    expect(fixture.stores.guidedToolJournal.find(exactCallId)?.status)
      .toBe("completed");
    expect(fixture.stores.guidedToolJournal.find(legacyCallId)?.status)
      .toBe("started");
  } finally {
    fixture.close();
  }
});

test("summaryless provider v1 started direct replay injects only an execution summary", async () => {
  const fixture = createFixture("guided-provider-v1-direct-summary-replay");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-provider-v1-direct-summary-replay-turn",
    });
    const providerCallId = "provider-direct-summary-replay";
    const summarylessArgs = {
      command: "pwd",
      state_effect: "read_only",
    };
    const oldCallId = digest([
      "btcc-guided-provider-tool-call.v1",
      turn.turnId,
      providerCallId,
      "run_command",
      stableJson(summarylessArgs),
    ].join("\0"));
    fixture.stores.guidedToolJournal.start({
      turnId: turn.turnId,
      callId: oldCallId,
      toolName: "run_command",
      rawArguments: JSON.stringify(summarylessArgs),
      arguments: summarylessArgs,
    });

    const dispatched: Array<{
      args: Record<string, unknown>;
      effectOccurrenceId?: string;
    }> = [];
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["run_command"]),
      visibleNames: new Set(["run_command"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      executeButlerTool: async (call, context) => {
        dispatched.push({
          args: call.args,
          ...(context?.effectOccurrenceId
            ? { effectOccurrenceId: context.effectOccurrenceId }
            : {}),
        });
        return { ok: true, direct: true };
      },
    });

    const result = await executor.executeTool({
      name: "run_command",
      args: summarylessArgs,
      rawArguments: JSON.stringify(summarylessArgs),
      providerCallId,
    });

    expect(result).toEqual({ ok: true, direct: true });
    expect(result).not.toHaveProperty("summary");
    expect(dispatched).toEqual([{
      args: {
        ...summarylessArgs,
        summary: expect.any(String),
      },
      effectOccurrenceId: oldCallId,
    }]);
    expect(fixture.stores.guidedToolJournal.list(turn.turnId)).toHaveLength(1);
    expect(fixture.stores.guidedToolJournal.find(oldCallId)?.status)
      .toBe("completed");
  } finally {
    fixture.close();
  }
});

test("summaryless provider v1 failed and cancelled records remain terminal", async () => {
  const fixture = createFixture("guided-provider-v1-terminal-replay");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-provider-v1-terminal-replay-turn",
    });
    const summarylessArgs = {
      command: "pwd",
      state_effect: "read_only",
    };
    const calls = [
      { providerCallId: "provider-v1-failed", status: "failed" as const },
      { providerCallId: "provider-v1-cancelled", status: "cancelled" as const },
    ];
    const callIds = new Map<string, string>();
    for (const call of calls) {
      const callId = digest([
        "btcc-guided-provider-tool-call.v1",
        turn.turnId,
        call.providerCallId,
        "run_command",
        stableJson(summarylessArgs),
      ].join("\0"));
      callIds.set(call.providerCallId, callId);
      fixture.stores.guidedToolJournal.start({
        turnId: turn.turnId,
        callId,
        toolName: "run_command",
        rawArguments: JSON.stringify(summarylessArgs),
        arguments: summarylessArgs,
      });
      fixture.stores.guidedToolJournal.finish({
        callId,
        status: call.status,
        ...(call.status === "cancelled" ? { errorCode: "cancelled" } : {}),
      });
    }

    const operations: string[] = [];
    let dispatches = 0;
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      progress: {
        stateChanged: async () => {},
        operationChanged: async (update) => {
          operations.push(update.status);
        },
      },
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["run_command"]),
      visibleNames: new Set(["run_command"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      executeButlerTool: async () => {
        dispatches += 1;
        return { ok: true };
      },
    });

    for (const call of calls) {
      const result = await executor.executeTool({
        name: "run_command",
        args: summarylessArgs,
        rawArguments: JSON.stringify(summarylessArgs),
        providerCallId: call.providerCallId,
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: call.status === "cancelled"
            ? "prior_tool_call_cancelled"
            : "prior_tool_call_failed",
        },
      });
    }
    expect(operations).toEqual([]);
    expect(dispatches).toBe(0);
    for (const call of calls) {
      expect(fixture.stores.guidedToolJournal.find(
        callIds.get(call.providerCallId)!,
      )?.status).toBe(call.status);
    }
  } finally {
    fixture.close();
  }
});

test("fresh progressive tool execution publishes its nested command summary", async () => {
  const fixture = createFixture("guided-progressive-command-publish");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-progressive-command-publish-turn",
    });
    const summary = "중첩 명령 요약을 공개 진행 상태에 사용합니다.";
    const operations: Array<{ status: string; inputLabel?: string }> = [];
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      progress: {
        stateChanged: async () => {},
        operationChanged: async (update) => {
          operations.push({
            status: update.status,
            ...(update.inputLabel !== undefined
              ? { inputLabel: update.inputLabel }
              : {}),
          });
        },
      },
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["tool_call"]),
      visibleNames: new Set(["tool_call"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      executeButlerTool: async () => ({ ok: true, exit_code: 0 }),
    });

    await executor.executeTool({
      name: "tool_call",
      args: {
        id: "native:run_command",
        arguments: { command: "pwd", summary },
      },
      rawArguments: JSON.stringify({
        id: "native:run_command",
        arguments: { command: "pwd", summary },
      }),
    });

    expect(operations).toEqual([
      { status: "started", inputLabel: summary },
      { status: "completed", inputLabel: summary },
    ]);
  } finally {
    fixture.close();
  }
});

test("progressive run_command without summary returns validation before public progress", async () => {
  const fixture = createFixture("guided-progressive-command-missing-summary");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "guided-progressive-command-missing-summary-turn",
    });
    const operations: Array<{ status: string }> = [];
    const activities: Array<{ title: string; summary: string }> = [];
    const activity = createGuidedActivityProjection({
      turnId: turn.turnId,
      managedInitially: true,
      progress: {
        stateChanged: async () => {},
        phaseActivityChanged(update) {
          activities.push({ title: update.title, summary: update.summary });
        },
      },
    });
    let dispatches = 0;
    const executor = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      activity,
      progress: {
        stateChanged: async () => {},
        operationChanged: async (update) => {
          operations.push({ status: update.status });
        },
      },
      workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
      authorizedNames: new Set(["tool_call"]),
      visibleNames: new Set(["tool_call"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      executeButlerTool: async () => {
        dispatches += 1;
        return { ok: true };
      },
    });

    const result = await executor.executeTool({
      name: "tool_call",
      args: {
        id: "native:run_command",
        arguments: { command: "pwd", state_effect: "read_only" },
      },
      rawArguments: JSON.stringify({
        id: "native:run_command",
        arguments: { command: "pwd", state_effect: "read_only" },
      }),
      providerCallId: "provider-fresh-summaryless",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_tool_arguments" },
    });
    expect(operations).toEqual([]);
    expect(activities).toEqual([]);
    expect(dispatches).toBe(0);
    expect(fixture.stores.guidedToolJournal.list(turn.turnId)).toEqual([]);
  } finally {
    fixture.close();
  }
});

test("run_command rejects a sanitizer-empty public summary before journal or dispatch", async () => {
  const fixture = createFixture("guided-command-unsafe-summary");
  try {
    const executeCases = [
      {
        turnId: "guided-command-unsafe-summary-direct",
        name: "run_command",
        args: {
          command: "pwd",
          summary: "Inspect /Users/alice/private/report.json",
        },
        visibleName: "run_command",
      },
      {
        turnId: "guided-command-unsafe-summary-progressive",
        name: "tool_call",
        args: {
          id: "native:run_command",
          arguments: {
            command: "pwd",
            summary: "Inspect /Users/alice/private/report.json",
          },
        },
        visibleName: "tool_call",
      },
    ] as const;
    for (const input of executeCases) {
      const turn = turnRecord(fixture.root, { turnId: input.turnId });
      let dispatches = 0;
      const executor = createGuidedToolCallExecutor({
        turn,
        signal: new AbortController().signal,
        workScope: { turnId: turn.turnId, sessionId: turn.sessionId },
        authorizedNames: new Set([input.visibleName]),
        visibleNames: new Set([input.visibleName]),
        describedToolIds: new Set(),
        durableWork: fixture.stores.durableWork,
        toolJournal: fixture.stores.guidedToolJournal,
        executeButlerTool: async () => {
          dispatches += 1;
          return { ok: true };
        },
      });
      const result = await executor.executeTool({
        name: input.name,
        args: input.args,
        rawArguments: JSON.stringify(input.args),
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_tool_arguments",
          path: "$.summary",
        },
      });
      expect(dispatches).toBe(0);
      expect(fixture.stores.guidedToolJournal.list(turn.turnId)).toEqual([]);
    }
  } finally {
    fixture.close();
  }
});

test("Guided agent turns provider failure into one fact-based final report", async () => {
  const fixture = createFixture("guided-fallback");
  try {
    writeFileSync(join(fixture.root, "settings.json"), '{"enabled":true}\n');
    let calls = 0;
    const fallbackAgent = fixture.agent(scriptedModelRound([
      (request) => {
        calls += 1;
        return toolResponse([
          toolCall("read-1", "read_file", { path: "settings.json" }),
        ], "설정 파일을 확인하겠습니다.");
      },
      () => {
        calls += 1;
        throw knownProviderFailure("provider disconnected after usable text");
      },
    ]));
    const outcome = await fallbackAgent.run({
      turn: turnRecord(fixture.root),
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({
      route: "assisted",
      content: "작업을 진행했지만 답변 생성을 마치지 못했습니다.\n완료되지 않은 작업을 완료로 처리하지 않았습니다.",
    });
    expect(calls).toBe(2);

    const commandAgent = fixture.agent(scriptedModelRound([
      toolResponse([toolCall("pwd-1", "run_command", {
        command: "pwd",
        summary: "현재 작업공간 위치를 확인합니다.",
        state_effect: "read_only",
      })]),
      { text: "폴더를 확인했습니다.", toolCalls: [] },
    ]));
    expect((await commandAgent.run({
      turn: turnRecord(fixture.root, { turnId: "turn-command" }),
      signal: new AbortController().signal,
    })).route).toBe("assisted");
  } finally {
    fixture.close();
  }
});

test("Guided agent preserves the caller signal without a whole-turn deadline", async () => {
  const fixture = createFixture("guided-caller-boundary");
  try {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const agent = fixture.agent(scriptedModelRound([
      (request) => {
        observedSignal = request.signal;
        return { text: "요청을 정상적으로 마쳤습니다.", toolCalls: [] };
      },
    ]));

    const outcome = await agent.run({
      turn: turnRecord(fixture.root, { turnId: "guided-caller-boundary-turn" }),
      signal: controller.signal,
    });

    expect(observedSignal).toBe(controller.signal);
    expect(observedSignal?.aborted).toBe(false);
    expect(outcome).toEqual({
      route: "direct",
      content: "요청을 정상적으로 마쳤습니다.",
    });
  } finally {
    fixture.close();
  }
});

test("Guided model never sees a whole-turn remaining-time field", async () => {
  const fixture = createFixture("guided-turn-time-context");
  try {
    writeFileSync(join(fixture.root, "settings.json"), '{"enabled":true}\n');
    let modelResult: Record<string, unknown> | undefined;
    let modelInstructions = "";
    const turn = turnRecord(fixture.root, { turnId: "guided-turn-time-context" });
    const agent = fixture.agent(scriptedModelRound([
      toolResponse([toolCall("read-1", "read_file", { path: "settings.json" })]),
      (request) => {
        modelInstructions = request.instructions ?? "";
        const toolMessage = messagesWithToolResults(request)[0];
        const payload = JSON.parse(toolMessage?.content ?? "{}") as {
          output?: Record<string, unknown>;
        };
        modelResult = payload.output;
        return { text: "확인했습니다.", toolCalls: [] };
      },
    ]));

    await agent.run({ turn, signal: new AbortController().signal });

    expect(modelResult).toBeDefined();
    expect(modelResult).not.toHaveProperty("turn_time_remaining_seconds");
    expect(modelInstructions).not.toContain("turn_time_remaining_seconds");
    const persisted = fixture.stores.guidedToolJournal.list(turn.turnId)[0]?.result;
    expect(persisted).toBeDefined();
    expect(persisted as Record<string, unknown>)
      .not.toHaveProperty("turn_time_remaining_seconds");
  } finally {
    fixture.close();
  }
});

test("Managed Work remains in the semantic loop while a model round is still running", async () => {
  const fixture = createFixture("guided-long-managed-round");
  let releaseRound = () => {};
  try {
    let roundStarted!: () => void;
    let settled = false;
    const roundRunning = new Promise<void>((resolve) => {
      roundStarted = resolve;
    });
    const delayedResult = new Promise<ModelRoundResult>((resolve) => {
      releaseRound = () => resolve({
        text: "긴 Managed Work를 끝까지 완료했습니다.",
        toolCalls: [],
      });
    });
    const agent = fixture.agent(scriptedModelRound([
      () => toolResponse([toolCall("long-plan-1", "replace_work_plan", {
        objective: "Finish the long Managed Work",
        actions: [{
          action_key: "finish-work",
          description: "Finish the requested Managed Work",
        }],
        checks: ["The requested Managed Work is complete"],
      })]),
      () => {
        roundStarted();
        return delayedResult;
      },
    ]));
    const running = agent.run({
      turn: turnRecord(fixture.root, {
        turnId: "guided-long-managed-round-turn",
        trackingMode: "local",
      }),
      signal: new AbortController().signal,
    }).then((outcome) => {
      settled = true;
      return outcome;
    });

    await roundRunning;
    expect(settled).toBe(false);
    releaseRound();

    await expect(running).resolves.toEqual({
      route: "managed",
      content: "긴 Managed Work를 끝까지 완료했습니다.",
    });
  } finally {
    releaseRound?.();
    fixture.close();
  }
});

test("Guided operational reporting preserves current and outdated saved result reviews", () => {
  const work: DurableWorkView = {
    workId: "work-completed",
    sessionId: "session-completed",
    scope: { kind: "session", sessionId: "session-completed" },
    origin: { turnId: "turn-completed", messageId: "message-completed" },
    objective: "Build and verify the requested page",
    status: "completed",
    currentStage: "reporting",
    allowedNextStages: ["review"],
    actionProgress: [],
    latestResultReview: {
      reviewRevisionId: "review-completed",
      revision: 1,
      subject: "result",
      verdict: "accept",
      summary: "The requested page was built and desktop and mobile rendering passed.",
      corrections: [],
      boundResultRefs: [],
      originTurnId: "turn-completed",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    resultRefs: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const facts = {
    originalRequest: "페이지를 만들어 주세요.",
    work,
    toolCalls: [],
    effects: [],
  };

  expect(guidedOperationalReportPrompt(facts)).toContain(
    "The requested page was built and desktop and mobile rendering passed.",
  );
  const fallback = guidedOperationalFallback(facts);
  expect(fallback).toContain("요청한 작업은 완료됐습니다");
  expect(fallback).toContain("desktop and mobile rendering passed");
  expect(fallback).not.toContain("Saved model result review");

  const outdated = {
    ...facts,
    work: {
      ...work,
      status: "open" as const,
      resultRefs: [{
        resultRef: "result-after-review",
        toolCallId: "call-after-review",
        toolName: "read_file",
        status: "completed" as const,
        originTurnId: "turn-completed",
        attachedAt: "2026-08-01T00:01:00.000Z",
      }],
    },
  };
  expect(guidedOperationalReportPrompt(outdated))
    .toContain("Outdated result summary");
  expect(guidedOperationalFallback(outdated))
    .not.toContain("Saved model result review");
});

test("Guided operational fallback does not count returned tool failures as success", () => {
  const fallback = guidedOperationalFallback({
    originalRequest: "실패한 도구 결과를 사실대로 알려 주세요.",
    work: null,
    toolCalls: Array.from({ length: 5 }, (_, index) => ({
      callId: `failed-call-${index}`,
      toolName: "run_command",
      rawArguments: "{}",
      arguments: {},
      status: "completed" as const,
      result: {
        ok: false,
        error: { code: "effect_plan_review_required" },
      },
    })),
    effects: [],
  });

  expect(fallback).toContain("답변 생성을 마치지 못했습니다");
  expect(fallback).not.toContain("journal");
  expect(fallback).not.toContain("Tool run_command");
  expect(fallback).not.toContain("rejected_or_failed");
});

test("Guided operational fallback follows configured response language", () => {
  const fallback = guidedOperationalFallback({
    originalRequest: "이 요청은 한국어로 작성되었습니다.",
    responseLanguage: "English",
    work: null,
    toolCalls: [],
    effects: [],
  });

  expect(fallback).toContain("could not finish generating the answer");
  expect(fallback).not.toContain("답변 생성을");
});

test("Guided operational fallback is captured without a second report model call", async () => {
  const toolCall = {
    callId: "guided-fallback-precomputed-call",
    toolName: "read_file",
    rawArguments: "{}",
    arguments: {},
    status: "started" as "started" | "completed",
    result: { marker: "captured-before-report-model" },
  };
  let calls = 0;

  const modelRound = scriptedModelRound([
    () => {
      calls += 1;
      throw knownProviderFailure("main provider failure");
    },
  ]);

  const answer = await runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "현재까지 확인한 내용을 알려 주세요.",
      tools: [],
      modelRound,
      maxIterations: 1,
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    originalRequest: "현재까지 확인한 내용을 알려 주세요.",
    loadFacts: async () => ({
      work: null,
      toolCalls: [toolCall],
      effects: [],
    }),
  });

  expect(calls).toBe(1);
  expect(answer).toContain("답변 생성을 마치지 못했습니다");
  expect(answer).not.toContain("Tool read_file");
  expect(answer).not.toContain("captured-before-report-model");
});

test("Guided operational fallback never exposes a model budget or retry request", async () => {
  let calls = 0;
  const modelRound = scriptedModelRound([
    () => {
      calls += 1;
      throw knownProviderFailure("main provider failure");
    },
  ]);

  const answer = await runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "결과를 알려 주세요.",
      tools: [],
      modelRound,
      maxIterations: 1,
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    originalRequest: "결과를 알려 주세요.",
    loadFacts: async () => ({
      work: null,
      toolCalls: [],
      effects: [],
    }),
  });

  expect(answer).toContain("답변 생성을 마치지 못했습니다");
  expect(answer).not.toContain("available tool budget");
  expect(answer).not.toContain("another turn");
  expect(answer).not.toMatch(/retry|다시 요청/iu);
  expect(calls).toBe(1);
});

test("Guided operational fallback is deterministic instead of a persona model call", async () => {
  let calls = 0;
  const modelRound = scriptedModelRound([
    () => {
      calls += 1;
      throw knownProviderFailure("main provider failure");
    },
  ]);

  const answer = await runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "작업을 완료해 줘.",
      tools: [],
      modelRound,
      maxIterations: 1,
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    originalRequest: "작업을 완료해 줘.",
    loadFacts: async () => ({ work: null, toolCalls: [], effects: [] }),
  });

  expect(answer).toContain("답변 생성을 마치지 못했습니다");
  expect(calls).toBe(1);
});

test("Guided empty main response returns a deterministic fact-based fallback", async () => {
  let calls = 0;
  let factLoads = 0;

  const modelRound = scriptedModelRound([
    () => {
      calls += 1;
      return { text: "   ", toolCalls: [] };
    },
  ]);

  const answer = await runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "빈 응답을 보고 가능한 실패로 처리해 주세요.",
      tools: [],
      modelRound,
      maxIterations: 1,
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    originalRequest: "빈 응답을 보고 가능한 실패로 처리해 주세요.",
    loadFacts: async () => {
      factLoads += 1;
      return { work: null, toolCalls: [], effects: [] };
    },
  });

  expect(answer).toContain("답변 생성을 마치지 못했습니다");
  expect(answer).not.toMatch(/다시 요청|retry|continue/iu);
  expect(calls).toBe(1);
  expect(factLoads).toBe(1);
});

test("Guided unexpected local failure does not start an operational report request", async () => {
  let calls = 0;
  let factLoads = 0;

  const modelRound = scriptedModelRound([
    () => {
      calls += 1;
      throw new Error("local prompt assembly invariant failed");
    },
  ]);

  await expect(runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "로컬 오류는 위로 전달해 주세요.",
      tools: [],
      modelRound,
      maxIterations: 1,
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    originalRequest: "로컬 오류는 위로 전달해 주세요.",
    loadFacts: async () => {
      factLoads += 1;
      return { work: null, toolCalls: [], effects: [] };
    },
  })).rejects.toThrow("local prompt assembly invariant failed");

  expect(calls).toBe(1);
  expect(factLoads).toBe(0);
});

test("Guided permanent provider failure does not start an operational report request", async () => {
  let calls = 0;
  let factLoads = 0;
  const permanent = new ModelProviderRequestError({
    code: "provider_auth_error",
    message: "provider credentials rejected",
    provider: "test-provider",
    retryable: false,
  });

  await expect(runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "영구적인 제공자 오류를 전달해 주세요.",
      tools: [],
      modelRound: scriptedModelRound([
        () => {
          calls += 1;
          throw permanent;
        },
      ]),
      maxIterations: 1,
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    originalRequest: "영구적인 제공자 오류를 전달해 주세요.",
    loadFacts: async () => {
      factLoads += 1;
      return { work: null, toolCalls: [], effects: [] };
    },
  })).rejects.toBe(permanent);

  expect(calls).toBe(1);
  expect(factLoads).toBe(0);
});

test("Guided parent cancellation does not deliver an operational fallback", async () => {
  const controller = new AbortController();
  const stopped = new Error("user stopped the Turn");
  let factLoads = 0;
  const modelRound = scriptedModelRound([
    (request) => new Promise<never>((_resolve, reject) => {
      const rejectOnAbort = () => reject(request.signal?.reason);
      if (request.signal?.aborted) rejectOnAbort();
      else request.signal?.addEventListener("abort", rejectOnAbort, { once: true });
    }),
  ]);
  const running = runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "중지할 작업",
      tools: [],
      modelRound,
      maxIterations: 1,
      executeTool: async () => undefined,
    },
    parentSignal: controller.signal,
    originalRequest: "중지할 작업",
    loadFacts: async () => {
      factLoads += 1;
      return {
        work: null,
        toolCalls: [],
        effects: [],
      };
    },
  });

  controller.abort(stopped);

  await expect(running).rejects.toThrow("user stopped the Turn");
  expect(factLoads).toBe(0);
});

function createFixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  const dbPath = join(root, "butler.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: label,
    storageProfile: "ephemeral",
  });
  return {
    root,
    dbPath,
    stores,
    agent(
      modelRound: ModelRoundPort,
      operational: { butlerHome?: string } = {},
    ) {
      const { butlerHome = root } = operational;
      return createProductionGuidedTurnAgent({
        butlerHome,
        butlerData: root,
        contextDocuments: stores.contextDocuments,
        toolJournal: stores.guidedToolJournal,
        operationResultReader: stores.guidedOperationResultReader,
        effectJournal: stores.guidedEffectJournal,
        durableWork: stores.durableWork,
        modelRound,
      });
    },
    close() {
      stores.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function runGit(args: string[], cwd: string, gitDir = false): string {
  const command = gitDir ? ["git", `--git-dir=${cwd}`, ...args] : ["git", ...args];
  const result = Bun.spawnSync({
    cmd: command,
    ...(gitDir ? {} : { cwd }),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function prepareAppProjectsTable(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.run(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      workspace_path TEXT,
      workspace_label TEXT,
      safe_path_label TEXT,
      ledger_project_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`);
  } finally {
    db.close(false);
  }
}

function bindAppProject(
  dbPath: string,
  input: {
    id: string;
    workspacePath: string;
    ledgerProjectId: string;
    archived?: boolean;
  },
): void {
  prepareAppProjectsTable(dbPath);
  const db = new Database(dbPath);
  try {
    db.query(`
      INSERT INTO projects (
        id, display_name, workspace_path, workspace_label, safe_path_label,
        ledger_project_id, archived, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.id,
      input.workspacePath,
      input.id,
      input.ledgerProjectId,
      input.ledgerProjectId,
      input.archived ? 1 : 0,
      "2026-07-31T00:00:00.000Z",
    );
  } finally {
    db.close(false);
  }
}

function fixtureMcpServerEval(): string {
  return `
    import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
    import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    import { z } from "zod";

    const server = new McpServer({ name: "guided-tool-fixture", version: "1.0.0" });
    server.tool("find_issue", "Find issue records", { query: z.string() }, async ({ query }) => ({
      content: [{ type: "text", text: "issue:" + query }],
    }));
    server.resource("fixture", "butler://fixture", async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: "fixture" }],
    }));
    await server.connect(new StdioServerTransport());
  `;
}

function turnRecord(
  workspacePath: string,
  options: {
    turnId?: string;
    accessMode?: "full_access" | "ask_first" | "read_only";
    trackingMode?: "ledger" | "local" | "none";
    projectId?: string;
    attachments?: NonNullable<TurnRecord["context"]["attachments"]>;
    attributionArmId?: string;
    cacheBoundaryEvidence?: NonNullable<
      TurnRecord["context"]["providerRequestAttribution"]
    >["cacheBoundaryEvidence"];
  } = {},
): TurnRecord {
  const turnId = options.turnId ?? "guided-agent-turn";
  return {
    turnId,
    sessionId: "guided-agent-session",
    inboxId: `inbox:${turnId}`,
    triggerKey: `trigger:${turnId}`,
    originalMessageId: `message:${turnId}`,
    originalMessage: "요청을 처리해 주세요",
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: options.accessMode ?? "full_access" },
      controlsHash: "controls",
    },
    context: {
      userRef: "local-user",
      ...(options.projectId ? { projectRef: options.projectId } : {}),
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [`workspace:${workspacePath}`],
      ...(options.attributionArmId || options.cacheBoundaryEvidence
        ? { providerRequestAttribution: {
            ...(options.attributionArmId ? { armId: options.attributionArmId } : {}),
            ...(options.cacheBoundaryEvidence
              ? { cacheBoundaryEvidence: options.cacheBoundaryEvidence }
              : {}),
          } }
        : {}),
      executionPolicy: {
        role: "butler",
        accessMode: options.accessMode ?? "full_access",
        trackingMode: options.trackingMode ?? "none",
        requiredNativeToolProfiles: [],
        requiredNativeTools: [],
        workspacePath,
        ...(options.projectId ? { projectId: options.projectId } : {}),
      },
      ...(options.attachments ? { attachments: options.attachments } : {}),
    },
    semanticState: "admitted",
    checkpoint: {
      checkpointId: `checkpoint:${turnId}`,
      checkpointRevision: 1,
      kind: "runtime",
      semanticState: "admitted",
    },
    revision: 0,
    executionFence: 0,
  };
}

function knownProviderFailure(message: string): ModelProviderRequestError {
  return new ModelProviderRequestError({
    code: "provider_api_error",
    message,
    provider: "test-provider",
    api: "test-api",
    retryable: true,
  });
}

function localRunCommand(
  workspacePath: string,
  turnId: string,
): Extract<BtccRunCommand, { kind: "run" }> {
  return {
    kind: "run",
    turnId,
    sessionId: "guided-local-session",
    triggerKey: `message:${turnId}`,
    message: {
      messageId: `message:${turnId}`,
      content: "기존 파일을 작게 수정해 주세요",
    },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: "full_access" },
      controlsHash: "controls",
    },
    context: {
      userRef: "local-user",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [`workspace:${workspacePath}`],
      executionPolicy: {
        role: "butler",
        accessMode: "full_access",
        trackingMode: "local",
        requiredNativeToolProfiles: ["workspace"],
        requiredNativeTools: [],
        workspacePath,
      },
    },
  };
}

function projectRunCommand(
  workspacePath: string,
  turnId: string,
): Extract<BtccRunCommand, { kind: "run" }> {
  return {
    kind: "run",
    turnId,
    sessionId: "guided-project-session",
    triggerKey: `message:${turnId}`,
    message: {
      messageId: `message:${turnId}`,
      content: "프로젝트 작업을 만들고 기록해 주세요",
    },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: "full_access" },
      controlsHash: "controls",
    },
    context: {
      userRef: "local-user",
      projectRef: "guided-project-session",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [`workspace:${workspacePath}`],
      executionPolicy: {
        role: "butler",
        accessMode: "full_access",
        trackingMode: "ledger",
        requiredNativeToolProfiles: ["workspace", "project", "project-lifecycle"],
        requiredNativeTools: [],
        workspacePath,
        projectId: "guided-project-session",
      },
    },
  };
}
