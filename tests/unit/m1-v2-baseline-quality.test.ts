import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { OperationalMetricEvent } from
  "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import { assessM1V2Repetition } from
  "../support/m1-v2-baseline/assess.ts";
import { readM1V2DbEvidence } from
  "../support/m1-v2-baseline/db-evidence.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("M1 v2 arm quality and database evidence", () => {
  test("accepts fixed-date web output only with URL, source bytes, and web tool evidence", () => {
    const result = assessM1V2Repetition({
      armId: "current-web-cold",
      targetStepId: "current-web-cold",
      evidence: evidence(
        "current-web-cold",
        "2026년 8월 10일 기준 비 예보가 없어 우산은 불필요합니다. 출처: https://example.test/weather",
      ),
      metrics: metrics("current-web-cold", [
        ["source_reference", 20],
        ["current_user_request", 30],
        ["provider_carrier_overhead", 50],
      ]),
      db: dbEvidence({ webToolCalls: 1, toolCalls: 1 }),
    });
    expect(result.status).toBe("accepted");
    expect(result.quality).toMatchObject({
      fixedDatePresent: true,
      umbrellaRecommendationPresent: true,
      sourceReferenceCount: 1,
      sourceGrounded: true,
    });
    expect(JSON.stringify(result)).not.toContain("example.test");
  });

  test("rejects web output when real source delivery evidence is absent", () => {
    const result = assessM1V2Repetition({
      armId: "current-web-cold",
      targetStepId: "current-web-cold",
      evidence: evidence(
        "current-web-cold",
        "2026년 8월 10일 기준 우산은 필요합니다. https://example.test/weather",
      ),
      metrics: metrics("current-web-cold", [
        ["current_user_request", 50],
        ["provider_carrier_overhead", 50],
      ]),
      db: dbEvidence({ webToolCalls: 1, toolCalls: 1 }),
    });
    expect(result.status).toBe("rejected");
    expect(result.reasons).toContain("source_evidence_missing");
  });

  test("requires landing file, build, render, rubric, and product tool evidence", () => {
    const result = assessM1V2Repetition({
      armId: "landing-cold",
      targetStepId: "landing-cold",
      evidence: evidence("landing-cold", "완료했습니다."),
      metrics: metrics("landing-cold", [
        ["current_user_request", 30],
        ["tool_schema", 30],
        ["provider_carrier_overhead", 40],
      ]),
      db: dbEvidence({
        toolCalls: 4,
        pagePreviewToolCalls: 1,
        buildCommandToolCalls: 1,
        fileMutationToolCalls: 2,
      }),
      landingValidation: {
        buildPassed: true,
        desktopPassed: true,
        mobilePassed: true,
        desktopScreenshotPresent: true,
        mobileScreenshotPresent: true,
        indexChanged: true,
        stylesChanged: true,
        butlerGrounded: true,
        featureBlockCount: 3,
        usageScenePresent: true,
        ctaPresent: true,
        responsiveCssPresent: true,
      },
    });
    expect(result.status).toBe("accepted");
    expect(result.quality.landing?.featureBlockCount).toBe(3);
    expect(result.work).toMatchObject({
      observed: true,
      status: "completed",
      planReviewVerdict: "accept",
      resultReviewVerdict: "accept",
      completionValidationVerdict: "accept",
      projectLedgerCloseoutObserved: true,
      duplicateEvidenceCount: 0,
      lostCorrectionEvidenceCount: null,
      stallObserved: false,
    });
  });

  test("reads bounded tool counts and quick_check from the actual turn database", () => {
    const root = mkdtempSync(join(tmpdir(), "m1-v2-db-evidence-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { recursive: true });
    const db = new Database(join(runtime, "turns.sqlite"));
    db.exec(`
      CREATE TABLE btcc_guided_tool_calls (
        call_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        started_at INTEGER NOT NULL
      );
      INSERT INTO btcc_guided_tool_calls VALUES
        ('1', 'turn-target', 'web_search', 1),
        ('2', 'turn-target', 'web_read', 2),
        ('3', 'turn-other', 'run_command', 3);
    `);
    db.close();
    expect(readM1V2DbEvidence(root, "turn-target")).toMatchObject({
      quickCheckDatabases: 1,
      quickCheckPassed: true,
      toolCalls: 2,
      webToolCalls: 2,
      buildCommandToolCalls: 0,
    });
  });
});

function evidence(stepId: string, finalText: string): Record<string, unknown> {
  return {
    ok: true,
    observations: [{
      stepId,
      turnId: `turn-${stepId}`,
      terminalState: "delivered",
      finalText,
      timing: {
        submittedAtMs: 100,
        acknowledgedAtMs: 110,
        firstRenderedActivityAtMs: 120,
        terminalAtMs: 300,
        elapsedMs: 200,
      },
      reload: { tested: true, finalMatched: true },
      expectations: { passed: true, failures: [] },
      work: {
        status: "completed",
        planRevision: 1,
        checkpointStage: "reporting",
        checkpointStages: ["planning", "execution", "review", "validation", "reporting"],
        planReviewVerdict: "accept",
        resultReviewVerdict: "accept",
        completionValidationVerdict: "accept",
        resultToolNames: ["write_file", "run_command", "inspect_workspace_page"],
        projectLedgerWorkRecords: 1,
        projectLedgerCompletedWorkRecords: 1,
        projectLedgerCloseoutObserved: true,
      },
    }],
    providerRequests: [{
      requestKind: "agent",
      requestStartedAtMs: 130,
      firstContentBearingDeltaAtMs: 20,
    }],
  };
}

function metrics(
  armId: string,
  segments: Array<[string, number]>,
): OperationalMetricEvent[] {
  const attemptDigest = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  return [
    metric("m1_v2_request_envelope", {
      attemptDigest,
      armId,
      providerSendBytes: 100,
      eligibility: "eligible",
      retryOrdinal: 0,
      roundIndex: 0,
    }),
    ...segments.map(([kind, providerSendBytes], index) =>
      metric("m1_v2_request_segment", {
        attemptDigest,
        segmentId: `segment-${index}`,
        kind,
        stability: "dynamic",
        providerSendBytes,
      })),
    metric("m1_v2_response_usage", {
      attemptDigest,
      status: "usage_bearing",
      promptTokens: 90,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
      outputTokens: 10,
      reasoningTokens: 0,
      totalTokens: 100,
    }),
  ];
}

function metric(
  name: string,
  dimensions: Record<string, string | number | boolean | null>,
): OperationalMetricEvent {
  return {
    schema: "butler.operational-metric.v1",
    ts: 150,
    category: "context",
    name,
    status: "ok",
    dimensions,
    rawTextStored: false,
  };
}

function dbEvidence(overrides: Partial<ReturnType<typeof readM1V2DbEvidence>>) {
  return {
    quickCheckDatabases: 1,
    quickCheckPassed: true,
    toolCalls: 0,
    webToolCalls: 0,
    pagePreviewToolCalls: 0,
    buildCommandToolCalls: 0,
    fileMutationToolCalls: 0,
    ...overrides,
  };
}
