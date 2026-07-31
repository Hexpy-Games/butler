import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRawProductObservation } from
  "../support/btcc-revision-benchmark/product-observation.ts";
import { readValidatorRejections } from
  "../support/btcc-revision-benchmark/loop-observation.ts";
import {
  firstMeaningfulEventTime,
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

  test("collects exact provider-boundary context and loop measurements", () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-benchmark-telemetry-"));
    const dataRoot = join(root, "data");
    mkdirSync(join(dataRoot, "app-server"), { recursive: true });
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
    const observation = collectRawProductObservation({
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
            requestKind: "main",
            requestStartedAtMs: 1_100,
            serializedRequestBytes: 4_000,
            firstContentBearingDeltaAtMs: 1_180,
            completedAtMs: null,
            status: 200,
            hasTextContent: true,
            hasToolArgumentContent: false,
            hasReasoningContent: true,
          },
          {
            ordinal: 2,
            requestKind: "main",
            requestStartedAtMs: 1_400,
            serializedRequestBytes: 1_000,
            firstContentBearingDeltaAtMs: 1_450,
            completedAtMs: 1_600,
            status: 200,
            hasTextContent: true,
            hasToolArgumentContent: false,
            hasReasoningContent: false,
          },
          {
            ordinal: 3,
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
        ],
      },
      fixtures: [],
      prompt: {
        id: "direct_greeting__run_1",
        tier: "direct",
        prompt: "안녕하세요.",
        requiredOutcomes: ["natural_greeting"],
        expectedLedgerRoute: "none",
        timeoutMs: 60_000,
        order: ["r2", "r3"],
      },
      revision: "r3",
      runId: "test-run",
      runRoot: root,
      target,
      timedOut: false,
    });
    expect(observation.usage).toMatchObject({
      modelRequests: 2,
      serializedContextBytes: 5_000,
    });
    expect(observation.timing).toMatchObject({
      modelRequestStartedAtMs: 1_100,
      firstProviderTokenAtMs: 1_180,
    });
    expect(observation.loop).toEqual({
      noProgressTurns: 1,
      validatorRejections: 0,
    });
    rmSync(root, { recursive: true, force: true });
  });
});

function event(
  atMs: number,
  kind: string,
  payload: Record<string, unknown> = {},
): TurnEvent {
  return { atMs, kind, payload, toolCallId: null };
}
