import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { createButlerToolExecutor } from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { hostedToolResultContent } from "../../packages/butler-agent/src/integrations/providers/shared/hosted-tool-result-context.ts";
import { promptUsageModelCallBudgetExhaustedError } from "../../packages/butler-agent/src/integrations/providers/shared/usage.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { AppGatewayBridge } from "../support/app-gateway-bridge.ts";
import { btccFixtureResponse } from "../support/btcc-phase-fixture.ts";
import { BtccPhaseStore } from "../../packages/butler-agent/src/agent/turn/btcc/phase-store.ts";

let data = "";

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "butler-app-evidence-loop-"));
});

afterEach(() => {
  rmSync(data, { recursive: true, force: true });
});

const provider: ModelProviderAdapter = {
  id: "app-evidence-loop-provider",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: true,
    supportsStructuredOutputs: true,
    structuredDecisionTransport: "json_schema",
  },
  async invoke() {
    return { text: "unused" };
  },
};

test("App message path rehydrates exact child evidence once without recursive artifacts", async () => {
  const dbPath = join(data, "app.sqlite");
  const sessionId = "butler/app-general";
  const executeNative = createButlerToolExecutor({
    butlerHome: process.cwd(),
    butlerData: data,
    sessionId,
  });
  let providerBoundaryCalls = 0;
  let originalArtifactId = "";
  let artifactCountAfterFirstBoundary = 0;
  let artifactCountAfterRehydration = 0;
  let runtimeError: unknown = null;
  const runtime = new NativeToolLoopRuntime({
    butlerHome: process.cwd(),
    butlerData: data,
    appMessageDbPath: dbPath,
    disableAutomaticRecall: true,
    runPromptText: async (input) => btccFixtureResponse({
      prompt: input.prompt,
      responseFormat: input.responseFormat,
      options: {
        action: "inspect",
        reportText: "App evidence hydration completed without recursive artifacts.",
        publicTitle: "증거 재수화 경로 점검",
        publicSummary: "큰 도구 결과를 보존한 뒤 필요한 원문 범위만 한 번 읽습니다.",
      },
    }),
    executeButlerTool: async (call) => {
      if (call.name === "run_command") {
        return {
          ok: true,
          exit_code: 0,
          stdout: Array.from({ length: 1_200 }, (_, index) =>
            `voice-contract-line-${String(index + 1).padStart(4, "0")}`,
          ).join("\n"),
          stderr: "",
        };
      }
      return await executeNative(call);
    },
    runFunctionToolPromptText: async (input) => {
      const firstRaw = await input.executeTool({
        name: "run_work_block",
        args: {
          decision: workBlockDecision("큰 조사 결과 보존", "큰 조사 결과를 child evidence로 보존합니다."),
          calls: [
            { name: "run_command", args: { command: "voice-contract-discovery" } },
            { name: "get_context_monitor", args: {} },
          ],
        },
        rawArguments: "{}",
      });
      const firstProvider = JSON.parse(hostedToolResultContent({
        payload: { ok: true, output: firstRaw },
        toolName: "run_work_block",
        toolCallId: "app-work-block-1",
        evidenceRetention: { butlerData: data, turnId: "app-evidence-turn" },
        log: () => undefined,
      })) as any;
      providerBoundaryCalls += 1;
      originalArtifactId = firstProvider.output.results[0].output.evidence_packet.artifact_id;
      expect(firstProvider.output.butler_work_block_result).toBe(true);
      expect(firstProvider.output.results[0].output.tool_name).toBe("run_command");
      artifactCountAfterFirstBoundary = evidenceArtifactCount(data);

      const secondRaw = await input.executeTool({
        name: "run_work_block",
        args: {
          decision: workBlockDecision("정확한 원문 범위 확인", "원본 artifact의 첫 범위만 다시 읽습니다."),
          calls: [{
            name: "read_tool_evidence_artifact",
            args: { artifact_id: originalArtifactId, offset_lines: 1, limit_lines: 80, max_tokens: 2_000 },
          }],
        },
        rawArguments: "{}",
      });
      const secondProvider = JSON.parse(hostedToolResultContent({
        payload: { ok: true, output: secondRaw },
        toolName: "run_work_block",
        toolCallId: "app-work-block-2",
        evidenceRetention: { butlerData: data, turnId: "app-evidence-turn" },
        log: () => undefined,
      })) as any;
      providerBoundaryCalls += 1;
      const hydrated = secondProvider.output.results[0].output;
      expect(hydrated).toMatchObject({
        schema_version: "butler.tool-evidence-rehydration.v1",
        terminal_evidence_observation: true,
        artifact: { id: originalArtifactId },
      });
      expect(hydrated.text.text).toContain("voice-contract-line-0001");
      expect(hydrated.text.text).not.toContain("voice-contract-line-1200");
      expect(hydrated.text.estimated_tokens).toBeLessThanOrEqual(2_000);
      expect(JSON.stringify(hydrated)).not.toContain("butler.completed-tool-evidence.v1");
      expect(hydrated.artifact).not.toHaveProperty("path");
      artifactCountAfterRehydration = evidenceArtifactCount(data);
      return "App evidence hydration completed without recursive artifacts.";
    },
  });
  const bridge = new AppGatewayBridge({
    butlerHome: process.cwd(),
    butlerData: data,
    runtime,
    provider,
    runtimePolicy: {
      completionReview: "disabled",
      requiredNativeToolProfiles: ["workspace"],
      requiredNativeTools: ["run_command", "read_tool_evidence_artifact", "get_context_monitor"],
    },
    sessionTitleGenerator: false,
    semanticLifecycleOwner: "bridge",
  });
  const originalRunTurn = runtime.runTurn.bind(runtime);
  runtime.runTurn = async (input) => {
    try {
      return await originalRunTurn(input);
    } catch (error) {
      runtimeError = error;
      throw error;
    }
  };
  const server = createAppServer({
    dbPath,
    butlerData: data,
    butlerHome: process.cwd(),
    port: 0,
    responder: bridge.responder,
    responderTimeoutMs: 10_000,
    automationSchedulerIntervalMs: false,
  });

  try {
    const accepted = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "큰 조사 결과를 확인하고 필요한 원문만 다시 읽어줘.",
    });
    expect(accepted.data.turn.state).toBe("thinking");
    const assistant = await waitForDeliveredAssistant(
      server.url,
      "general",
      () => runtimeError instanceof Error ? `${runtimeError.name}: ${runtimeError.message}\n${runtimeError.stack ?? ""}` : runtimeError,
    );
    expect(assistant.text).toBe("App evidence hydration completed without recursive artifacts.");
    expect(providerBoundaryCalls).toBe(2);
    expect(originalArtifactId).toStartWith("evidence_");
    expect(artifactCountAfterFirstBoundary).toBeGreaterThan(0);
    expect(artifactCountAfterRehydration).toBe(artifactCountAfterFirstBoundary);
    expect(evidenceArtifactCount(data)).toBe(artifactCountAfterFirstBoundary);
    const rawArtifacts = evidenceArtifacts(data);
    expect(rawArtifacts.some((artifact) =>
      String(artifact.serialized_text ?? "").includes("voice-contract-line-1200"),
    )).toBe(true);
    expect(rawArtifacts.every((artifact) =>
      !JSON.stringify(artifact).includes("butler_work_block_result") &&
      !JSON.stringify(artifact).includes("butler.tool-evidence-rehydration.v1"),
    )).toBe(true);

    const turns = await getJson(`${server.url}turns?chat_id=general`);
    const latest = turns.data.turns.at(-1);
    expect(latest.state).toBe("delivered");
    const phaseStore = new BtccPhaseStore({ butlerData: data });
    try {
      const phaseState = phaseStore.readPhaseState(latest.id);
      const reportingReceiptRef = phaseState?.acceptedReceiptRefs.find((receiptRef) =>
        phaseStore.readPhaseReceipt(receiptRef)?.phase === "reporting",
      );
      expect(phaseState?.lifecycleStatus).toBe("delivered");
      expect(reportingReceiptRef).toBeString();
      const legacyContract = onlyLegacyTurnContract(data);
      const statusObligation = legacyContract.required_evidence.find(
        (obligation: any) => obligation.deliverable === "status_report",
      );
      const expectedReceiptId = `turn-evidence-${createHash("sha256").update(
        `${legacyContract.contract_id}\n${statusObligation.obligation_id}\n${reportingReceiptRef}`,
      ).digest("hex").slice(0, 24)}`;
      expect(legacyContract).toMatchObject({
        state: "delivered",
        evidence_receipt_ids: expect.arrayContaining([expectedReceiptId]),
      });
    } finally {
      phaseStore.close();
    }
    const events = await getJson(`${server.url}events?cursor=0`);
    expect(JSON.stringify(events)).not.toContain("turn.continuation_scheduled");
    expect(turnContextAtomCount(data)).toBe(0);
    const eventCount = events.data.events.length;
    await Bun.sleep(250);
    const stableEvents = await getJson(`${server.url}events?cursor=0`);
    expect(stableEvents.data.events).toHaveLength(eventCount);
  } finally {
    server.stop();
    bridge.close();
  }
});

test("App budget interruption stays recoverable until Stop starts a new intent", async () => {
  const dbPath = join(data, "app.sqlite");
  let firstTurnActive = true;
  let toolPromptCalls = 0;
  let finalizationAttempts = 0;
  const runtime = new NativeToolLoopRuntime({
    butlerHome: process.cwd(),
    butlerData: data,
    appMessageDbPath: dbPath,
    disableAutomaticRecall: true,
    runPromptText: async (input) => {
      if (input.usageAttribution?.phase === "budget_exhaustion_finalization") {
        finalizationAttempts += 1;
        firstTurnActive = false;
        throw promptUsageModelCallBudgetExhaustedError();
      }
      return btccFixtureResponse({
        prompt: input.prompt,
        responseFormat: input.responseFormat,
        options: firstTurnActive
          ? {
            action: "inspect",
            publicTitle: "긴 조사 실행",
            publicSummary: "도구 조사를 실행하고 결과를 확인합니다.",
          }
          : {
            action: "answer",
            answerText: "후속 질문의 새 의도에만 답했습니다.",
            reportText: "후속 질문의 새 의도에만 답했습니다.",
            publicTitle: "후속 질문 답변",
            publicSummary: "후속 질문에 답합니다.",
          },
      });
    },
    runFunctionToolPromptText: async () => {
      toolPromptCalls += 1;
      firstTurnActive = false;
      throw promptUsageModelCallBudgetExhaustedError();
    },
  });
  const bridge = new AppGatewayBridge({
    butlerHome: process.cwd(),
    butlerData: data,
    runtime,
    provider,
    runtimePolicy: {
      completionReview: "disabled",
      requiredNativeTools: ["get_context_monitor"],
    },
    sessionTitleGenerator: false,
  });
  const server = createAppServer({
    dbPath,
    butlerData: data,
    butlerHome: process.cwd(),
    port: 0,
    responder: bridge.responder,
    responderTimeoutMs: 10_000,
    automationSchedulerIntervalMs: false,
  });

  try {
    const first = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "첫 번째 긴 조사를 실행해줘.",
    });
    const firstTurn = await waitForLatestTurnMatching(
      server.url,
      "general",
      (turn) => turn.id === first.data.turn.id && turn.state === "waiting_for_tool",
    );
    expect(firstTurn).toMatchObject({
      state: "waiting_for_tool",
      attempt: 1,
      retryable: false,
      cancellable: true,
    });
    expect(firstTurn.safe_error_code ?? null).toBeNull();
    expect(toolPromptCalls).toBe(1);
    expect(finalizationAttempts).toBe(0);
    expect(turnContextAtomCount(data)).toBe(0);

    const firstEvents = await getJson(`${server.url}events?cursor=0`);
    expect(JSON.stringify(firstEvents)).not.toContain("turn.continuation_scheduled");
    expect(JSON.stringify(firstEvents)).not.toContain("turn_scheduler_continuation_yield");
    expect(JSON.stringify(firstEvents)).not.toContain("turn.failed");
    await Bun.sleep(250);
    const stableTurns = await getJson(`${server.url}turns?chat_id=general`);
    expect(stableTurns.data.turns[0]).toMatchObject({
      id: first.data.turn.id,
      state: "waiting_for_tool",
      attempt: 1,
    });
    const stableFirstEvents = await getJson(`${server.url}events?cursor=0`);
    expect(stableFirstEvents.data.events).toHaveLength(firstEvents.data.events.length);

    const stopped = await postJson(
      `${server.url}turns/${encodeURIComponent(first.data.turn.id)}/cancel`,
      {},
    );
    expect(stopped.data.turn).toMatchObject({
      id: first.data.turn.id,
      state: "cancelled",
      cancellable: false,
    });

    const second = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "이제 첫 요청과 무관한 후속 질문에만 답해줘.",
    });
    const assistant = await waitForDeliveredAssistant(
      server.url,
      "general",
      () => null,
      second.data.turn.id,
    );
    expect(assistant.text).toBe("후속 질문의 새 의도에만 답했습니다.");
    expect(toolPromptCalls).toBe(1);
    expect(finalizationAttempts).toBe(0);
    expect(turnContextAtomCount(data)).toBe(0);

    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns).toHaveLength(2);
    expect(turns.data.turns.at(-1)).toMatchObject({
      id: second.data.turn.id,
      state: "delivered",
    });
  } finally {
    server.stop();
    bridge.close();
  }
});

function workBlockDecision(title: string, summary: string): Record<string, unknown> {
  return {
    title,
    summary,
    rationale: "재수화는 원본 artifact에만 접근하고 새 artifact를 만들면 안 됩니다.",
    next_step: "확인된 원문을 사용해 최종 결과를 작성합니다.",
    expected_effect: "artifact 깊이와 개수가 증가하지 않습니다.",
  };
}

function evidenceArtifactCount(root: string): number {
  const artifactRoot = join(root, "artifacts", "tool-evidence");
  if (!existsSync(artifactRoot)) return 0;
  return readdirSync(artifactRoot, { recursive: true })
    .filter((entry) => String(entry).endsWith(".json"))
    .length;
}

function evidenceArtifacts(root: string): Array<Record<string, unknown>> {
  const artifactRoot = join(root, "artifacts", "tool-evidence");
  if (!existsSync(artifactRoot)) return [];
  return readdirSync(artifactRoot, { recursive: true })
    .filter((entry) => String(entry).endsWith(".json"))
    .map((entry) => JSON.parse(readFileSync(join(artifactRoot, String(entry)), "utf8")));
}

function turnContextAtomCount(root: string): number {
  const atomRoot = join(root, "state", "turn-kernel");
  if (!existsSync(atomRoot)) return 0;
  return readdirSync(atomRoot, { recursive: true })
    .filter((entry) => String(entry).endsWith(".json"))
    .length;
}

function onlyLegacyTurnContract(root: string): any {
  const contractRoot = join(root, "turn-contracts");
  const paths = readdirSync(contractRoot)
    .map((entry) => String(entry))
    .filter((entry) => entry.startsWith("contract-") && entry.endsWith(".json"));
  expect(paths).toHaveLength(1);
  return JSON.parse(readFileSync(join(contractRoot, paths[0]!), "utf8"));
}

async function postJson(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${url} failed: ${response.status}`);
  return await response.json();
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return await response.json();
}

async function waitForDeliveredAssistant(
  baseUrl: string,
  chatId: string,
  runtimeDiagnostic: () => unknown,
  turnId?: string,
): Promise<any> {
  const deadline = Date.now() + 10_000;
  let latest: any = null;
  while (Date.now() < deadline) {
    const view = await getJson(`${baseUrl}messages?chat_id=${encodeURIComponent(chatId)}`);
    latest = view;
    const messages = view.data.messages as any[];
    const assistant = messages.find((message) =>
      message.role === "assistant" && message.status === "delivered" &&
      (!turnId || message.turn_id === turnId),
    );
    if (assistant) return assistant;
    await Bun.sleep(25);
  }
  const turns = await getJson(`${baseUrl}turns?chat_id=${encodeURIComponent(chatId)}`);
  throw new Error(`timed out waiting for delivered assistant message: ${JSON.stringify({
    latest,
    turns,
    runtimeDiagnostic: runtimeDiagnostic(),
  })}`);
}

async function waitForLatestTurnMatching(
  baseUrl: string,
  chatId: string,
  predicate: (turn: any) => boolean,
): Promise<any> {
  const deadline = Date.now() + 10_000;
  let latest: any = null;
  while (Date.now() < deadline) {
    const turns = await getJson(`${baseUrl}turns?chat_id=${encodeURIComponent(chatId)}`);
    latest = turns;
    const match = (turns.data.turns as any[]).find(predicate);
    if (match) return match;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for matching App turn: ${JSON.stringify(latest)}`);
}
