import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRawProductObservation } from
  "../support/btcc-revision-benchmark/product-observation.ts";
import { readValidatorRejections } from
  "../support/btcc-revision-benchmark/loop-observation.ts";
import {
  firstMeaningfulEventTime,
  summarizeTools,
  type TurnEvent,
} from "../support/btcc-revision-benchmark/product-telemetry.ts";

describe("BTCC revision benchmark product telemetry", () => {
  test("ignores generic protocol progress when finding the first meaningful event", () => {
    const events: TurnEvent[] = [
      event(10, "turn.started"),
      event(20, "assistant.public_note", {
        note: "모델 응답을 기다리고 있습니다",
        bridgePhase: "model_round_waiting",
      }),
      event(30, "assistant.public_note", {
        note: "검색 결과에서 핵심 수치를 확인했습니다.",
        decisionSource: "model-authored",
      }),
      event(40, "message.final.started"),
    ];
    expect(firstMeaningfulEventTime(events)).toBe(30);
    expect(firstMeaningfulEventTime(events.slice(0, 2))).toBeNull();
    expect(firstMeaningfulEventTime([
      event(10, "turn.started"),
      event(40, "message.final.started"),
    ])).toBe(40);
    expect(firstMeaningfulEventTime([
      event(10, "turn.started"),
      event(25, "assistant.decision", { title: "자료를 확인하겠습니다." }),
      event(40, "message.final.started"),
    ])).toBe(25);
  });

  test("counts rejected R2 provider products from retained terminal evidence", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE btcc_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        accepted_product_json TEXT
      );
      CREATE TABLE btcc_phase_model_rounds (
        round_id TEXT PRIMARY KEY,
        checkpoint_id TEXT NOT NULL,
        carrier_kind TEXT NOT NULL
      );
      CREATE TABLE btcc_phase_checkpoint_revisions (
        checkpoint_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE btcc_operational_interruptions (
        turn_id TEXT NOT NULL,
        diagnostic_json TEXT,
        activation_count INTEGER NOT NULL
      );
      INSERT INTO btcc_checkpoints VALUES ('accepted', 'turn-r2', '{}');
      INSERT INTO btcc_phase_model_rounds VALUES
        ('round-1', 'accepted', 'operation_requests'),
        ('round-2', 'accepted', 'operation_requests'),
        ('round-3', 'accepted', 'phase_submission');
      INSERT INTO btcc_phase_checkpoint_revisions VALUES
        ('accepted', 'provider_product_rejected'),
        ('accepted', 'provider_product_rejected');
      INSERT INTO btcc_checkpoints VALUES ('active', 'turn-r2', NULL);
      INSERT INTO btcc_phase_checkpoint_revisions VALUES
        ('active', 'provider_product_rejected'), ('active', 'pending_boundary');
      INSERT INTO btcc_operational_interruptions VALUES
        ('turn-r2', '{"kind":"provider_carrier_rejection"}', 2),
        ('turn-r2', '{"kind":"provider_timeout"}', 9);
    `);
    expect(readValidatorRejections(db, "turn-r2")).toBe(5);
    db.close();
  });

  test("reports zero validator rejections for the validator-free R3 runtime", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE btcc_guided_tool_calls (call_id TEXT PRIMARY KEY)");
    expect(readValidatorRejections(db, "turn-r3")).toBe(0);
    db.close();
  });

  test("retains a safe paired timeline of tool events without judging tool choice", () => {
    const summary = summarizeTools([
      event(100, "tool.started", {
        toolCallId: "call-1",
        toolName: "web_search",
      }),
      event(145, "tool.completed", {
        toolCallId: "call-1",
        toolName: "web_search",
      }),
      event(160, "tool.started", {
        toolCallId: "call-2",
        toolName: "read_file\nprivate label omitted",
      }),
      event(190, "tool.failed", {
        toolCallId: "call-2",
      }),
      event(210, "tool.failed", {
        toolCallId: "orphan",
        toolName: "write_file",
      }),
    ], false, 220);

    expect(summary.observations).toEqual([
      {
        callId: "call-1",
        toolName: "web_search",
        status: "completed",
        startedAtMs: 100,
        endedAtMs: 145,
        elapsedMs: 45,
      },
      {
        callId: "call-2",
        toolName: null,
        status: "failed",
        startedAtMs: 160,
        endedAtMs: 190,
        elapsedMs: 30,
      },
      {
        callId: "orphan",
        toolName: "write_file",
        status: "failed",
        startedAtMs: null,
        endedAtMs: 210,
        elapsedMs: null,
      },
    ]);
  });

  test("collects Turn-bounded provider usage and excludes post-terminal work", () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-benchmark-telemetry-"));
    const dataRoot = join(root, "data");
    mkdirSync(join(dataRoot, "app-server"), { recursive: true });
    mkdirSync(join(dataRoot, "metrics"), { recursive: true });
    writeFileSync(join(dataRoot, "metrics", "prompt-cache-usage.jsonl"), [
      { ts: 1_200, model: "test-model", promptTokens: 10, cachedTokens: 0, totalTokens: 12 },
      { ts: 1_500, model: "test-model", promptTokens: 20, cachedTokens: 0, totalTokens: 24 },
      { ts: 2_100, model: "test-model", promptTokens: 30, cachedTokens: 0, totalTokens: 36 },
      { model: "test-model", promptTokens: 40, cachedTokens: 0, totalTokens: 48 },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const db = new Database(join(dataRoot, "app-server", "butler-client.sqlite"));
    db.exec("CREATE TABLE btcc_guided_tool_calls (call_id TEXT PRIMARY KEY)");
    db.close();
    const target = {
      revision: "r3" as const,
      worktreePath: "/tmp/r3",
      commit: "3".repeat(40),
      buildId: `sha256:${"3".repeat(64)}`,
      appBaseUrl: "http://127.0.0.1:28766",
      electronDebugPort: 29766,
      dataRoot,
      electronUserData: join(root, "electron"),
      workspaceRoot: join(root, "workspace"),
      model: "openai/test-model",
      reasoningEffort: "low",
      permissionMode: "full_access",
      fixtureHash: "fixture-v1",
    };
    const collectionInput: Parameters<typeof collectRawProductObservation>[0] = {
      artifactPaths: [],
      evidence: {
        run: { dataRoot, workspaceRoot: target.workspaceRoot },
        observations: [{
          turnId: "turn-r3",
          terminalState: "delivered",
          finalText: "완료했습니다.",
          timing: { submittedAtMs: 1_000, terminalAtMs: 2_000 },
        }],
        providerRequests: [
          {
            ordinal: 1,
            requestKind: "agent",
            requestStartedAtMs: 1_100,
            serializedRequestBytes: 4_000,
            firstContentBearingDeltaAtMs: 1_180,
            completedAtMs: null,
            status: 200,
            hasTextContent: true,
            hasToolArgumentContent: false,
            hasReasoningContent: true,
            streamedTextChars: 11,
            finalTextChars: 11,
          },
          {
            ordinal: 2,
            requestKind: "agent",
            requestStartedAtMs: 1_400,
            serializedRequestBytes: 1_000,
            firstContentBearingDeltaAtMs: 1_450,
            completedAtMs: 1_600,
            status: 200,
            hasTextContent: true,
            hasToolArgumentContent: false,
            hasReasoningContent: false,
            streamedTextChars: 7,
            finalTextChars: 7,
          },
          {
            ordinal: 3,
            requestKind: "tool_provider",
            requestStartedAtMs: 1_610,
            serializedRequestBytes: 900,
            firstContentBearingDeltaAtMs: 1_640,
            completedAtMs: 1_690,
            terminatedAtMs: 1_690,
            status: 200,
            hasTextContent: true,
            hasToolArgumentContent: false,
            hasReasoningContent: false,
            streamedTextChars: 40,
            finalTextChars: 40,
          },
          {
            ordinal: 4,
            requestKind: "title",
            requestStartedAtMs: 1_700,
            serializedRequestBytes: 500,
            firstContentBearingDeltaAtMs: 1_720,
            completedAtMs: 1_800,
            status: 200,
            hasTextContent: true,
            hasToolArgumentContent: false,
            hasReasoningContent: false,
          },
          {
            ordinal: 5,
            requestKind: "agent",
            requestStartedAtMs: 2_100,
            serializedRequestBytes: 9_999,
            firstContentBearingDeltaAtMs: 2_120,
            completedAtMs: 2_150,
            terminatedAtMs: 2_150,
            status: 200,
            hasTextContent: true,
            hasToolArgumentContent: false,
            hasReasoningContent: false,
            streamedTextChars: 99,
            finalTextChars: 99,
          },
          {
            ordinal: 6,
            requestKind: "tool_provider",
            requestStartedAtMs: 2_200,
            serializedRequestBytes: 8_888,
            firstContentBearingDeltaAtMs: 2_230,
            completedAtMs: 2_300,
            terminatedAtMs: 2_300,
            status: 200,
            hasTextContent: true,
            hasToolArgumentContent: false,
            hasReasoningContent: false,
            streamedTextChars: 88,
            finalTextChars: 88,
          },
        ],
      },
      fixtures: [],
      prompt: {
        id: "direct_greeting__run_1",
        tier: "direct",
        prompt: "안녕하세요.",
        requiredOutcomes: ["natural_greeting"],
        expectedLedgerRoute: "none",
        latencyTargetMs: 500,
        hardStopMs: 300_000,
        order: ["r2", "r3"],
      },
      revision: "r3",
      runId: "test-run",
      runRoot: root,
      target,
      timedOut: false,
    };
    const observation = collectRawProductObservation(collectionInput);
    expect(observation.usage).toMatchObject({
      modelRequests: 2,
      serializedContextBytes: 5_000,
      toolProviderRequests: 1,
      toolProviderElapsedMs: 80,
    });
    expect(observation.terminalState).toBe("delivered");
    expect(observation.timing).toMatchObject({
      latencyTargetMs: 500,
      hardStopMs: 300_000,
      latencyTargetMet: false,
    });
    expect(observation.timing).toMatchObject({
      modelRequestStartedAtMs: 1_100,
      firstProviderTokenAtMs: 1_180,
    });
    expect(observation.loop).toEqual({
      noProgressTurns: 1,
      validatorRejections: 0,
    });
    expect(observation.text).toEqual({
      finalCharacters: 7,
      streamedCharacters: 7,
    });
    const legacyEvidence = structuredClone(collectionInput.evidence);
    legacyEvidence.providerRequests = (
      legacyEvidence.providerRequests as Array<Record<string, unknown>>
    ).map((request) => request.requestKind === "agent"
      ? { ...request, requestKind: "main" }
      : request.requestKind === "title"
        ? { ...request, requestStartedAtMs: 900 }
        : request);
    const legacy = collectRawProductObservation({
      ...collectionInput,
      evidence: legacyEvidence,
    });
    expect(legacy).toMatchObject({
      text: { streamedCharacters: null },
      usage: {
        modelRequests: 2,
        serializedContextBytes: null,
        toolProviderRequests: null,
        toolProviderElapsedMs: null,
      },
      timing: {
        modelRequestStartedAtMs: 1_100,
        firstProviderTokenAtMs: null,
      },
      loop: { noProgressTurns: null },
    });
    const hardStopped = collectRawProductObservation({
      ...collectionInput,
      timedOut: true,
    });
    expect(hardStopped).toMatchObject({
      terminalState: "timed_out",
      quality: {
        intentScore: null,
        resultScore: null,
        requiredOutcomes: { natural_greeting: null },
        assessmentNote: null,
      },
      timing: { latencyTargetMet: false },
    });
    rmSync(root, { recursive: true, force: true });
  });
});

function event(
  atMs: number,
  kind: string,
  payload: Record<string, unknown> = {},
): TurnEvent {
  return {
    atMs,
    kind,
    payload,
    toolCallId: typeof payload.toolCallId === "string"
      ? payload.toolCallId
      : null,
  };
}
