import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { JSDOM } from "jsdom";
import type { OperationalMetricEvent } from
  "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import { assessM1V2Repetition } from
  "../support/m1-v2-baseline/assess.ts";
import { readM1V2DbEvidence } from
  "../support/m1-v2-baseline/db-evidence.ts";
import type { M1V2ApprovedCapabilityClaim } from
  "../support/m1-v2-baseline/contracts.ts";
import { assessM1V2LandingGrounding, extractM1V2LandingClaimElements } from
  "../support/m1-v2-baseline/landing-validation.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("M1 v2 arm quality and database evidence", () => {
  test("freezes Butler-specific landing grounding instead of accepting generic AI copy", () => {
    const grounded = assessM1V2LandingGrounding([
      "Butler는 durable project Work의 검토를 유지합니다.",
      "Butler는 memory context를 활용합니다.",
      "도구는 workspace 권한 안에서 실행됩니다.",
      "provider routing으로 모델 경로를 선택합니다.",
      "실패 상태에서 재시작 복구를 지원합니다.",
    ]);
    expect(grounded).toMatchObject({
      durableProjectWorkGrounded: true,
      memoryContextGrounded: true,
      toolsWorkspaceGrounded: true,
      providerRoutingGrounded: true,
      recoveryGrounded: true,
      genericCopyAbsent: true,
    });
    expect(grounded.approvedCapabilityClaims.every((claim) => claim.passed)).toBe(true);
    const invalid = assessM1V2LandingGrounding([
      "혁신적인 AI 비서로 생산성을 극대화하세요.",
      "provider routing은 지원하지 않습니다.",
      "모든 memory context를 무제한 저장합니다.",
    ]);
    expect(invalid).toMatchObject({
      durableProjectWorkGrounded: false,
      memoryContextGrounded: false,
      toolsWorkspaceGrounded: false,
      providerRoutingGrounded: false,
      recoveryGrounded: false,
      genericCopyAbsent: false,
    });
    expect(invalid.approvedCapabilityClaims.some((claim) =>
      claim.negated || claim.misrepresented)).toBe(true);
    const englishNegation = assessM1V2LandingGrounding([
      "Butler does not support durable project Work review.",
      "Butler stores all memory context without limits.",
      "Provider routing always uses the same provider.",
      "Recovery always succeeds 100% after a failed state.",
      "Durable project Work automatically completes without review.",
    ]);
    expect(englishNegation.approvedCapabilityClaims.every((claim) => !claim.passed)).toBe(true);
    const nestedDocument = new JSDOM(`
      <section>
        <p>Butler supports a durable project.</p>
        <p>Work review is available in another nested section.</p>
      </section>
    `).window.document;
    const extracted = extractM1V2LandingClaimElements(nestedDocument);
    expect(extracted).toEqual([
      "Butler supports a durable project.",
      "Work review is available in another nested section.",
    ]);
    const nestedBoundary = assessM1V2LandingGrounding(extracted);
    expect(nestedBoundary.durableProjectWorkGrounded).toBe(false);
  });

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
        durableProjectWorkGrounded: true,
        memoryContextGrounded: true,
        toolsWorkspaceGrounded: true,
        providerRoutingGrounded: true,
        recoveryGrounded: true,
        genericCopyAbsent: true,
        approvedCapabilityClaims: approvedClaims(true),
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
      lostCorrectionEvidenceCount: 0,
      lostRequiredAnchorCount: 0,
      workspaceAuthorityPassed: true,
      providerRoutingPassed: true,
      stallObserved: false,
    });
  });

  test("rejects landing when frozen grounding or safety evidence is unavailable", () => {
    const inputEvidence = evidence("landing-cold", "완료했습니다.");
    const target = (inputEvidence.observations as Array<Record<string, unknown>>)[0]!;
    target.work = null;
    const result = assessM1V2Repetition({
      armId: "landing-cold",
      targetStepId: "landing-cold",
      evidence: inputEvidence,
      metrics: metrics("landing-cold", [
        ["current_user_request", 30],
        ["tool_schema", 30],
        ["provider_carrier_overhead", 40],
      ]),
      db: dbEvidence({
        toolCalls: 3,
        pagePreviewToolCalls: 1,
        buildCommandToolCalls: 1,
        fileMutationToolCalls: 1,
        duplicateAppliedEffects: null,
        unresolvedCorrections: null,
        lostRequiredAnchors: null,
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
        durableProjectWorkGrounded: false,
        memoryContextGrounded: false,
        toolsWorkspaceGrounded: false,
        providerRoutingGrounded: false,
        recoveryGrounded: false,
        genericCopyAbsent: false,
        approvedCapabilityClaims: approvedClaims(false),
      },
    });
    expect(result.status).toBe("rejected");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "landing_quality_or_visual_gate_failed",
      "duplicate_effect_evidence_unavailable",
      "correction_evidence_unavailable",
      "required_anchor_evidence_unavailable",
      "landing_durable_work_missing",
      "landing_plan_review_missing",
      "landing_result_review_missing",
      "landing_completion_validation_missing",
    ]));
  });

  test("compares accepted correction and governing-anchor preservation without exporting content", () => {
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
        started_at INTEGER NOT NULL,
        result_json TEXT
      );
      INSERT INTO btcc_guided_tool_calls VALUES
        ('1', 'turn-target', 'web_search', 1, '{}'),
        ('2', 'turn-target', 'web_read', 2, '{}'),
        ('3', 'turn-other', 'run_command', 3, '{}');
      CREATE TABLE btcc_guided_turn_work_bindings (
        turn_id TEXT, is_current INTEGER, work_id TEXT
      );
      CREATE TABLE btcc_guided_effects (
        receipt_id TEXT, identity_sha256 TEXT, work_id TEXT, status TEXT,
        receipt_json TEXT, journal_revision INTEGER
      );
      CREATE TABLE btcc_guided_work_review_revisions (
        review_revision_id TEXT, work_id TEXT, subject TEXT, revision INTEGER,
        corrections_json TEXT, verdict TEXT,
        bound_plan_revision_id TEXT, bound_result_sequence INTEGER,
        bound_result_review_revision_id TEXT, bound_action_states_json TEXT
      );
      CREATE TABLE btcc_guided_work_effect_blockers (
        status TEXT, source_turn_id TEXT, work_id TEXT
      );
      CREATE TABLE btcc_guided_work_plan_revisions (
        plan_revision_id TEXT, work_id TEXT, revision INTEGER, objective TEXT,
        governing_refs_json TEXT, actions_json TEXT, checks_json TEXT
      );
      CREATE TABLE btcc_guided_work_results (
        work_id TEXT, sequence INTEGER, tool_call_id TEXT
      );
      CREATE TABLE btcc_guided_work_checkpoint_revisions (
        work_id TEXT, revision INTEGER, action_states_json TEXT
      );
      INSERT INTO btcc_guided_turn_work_bindings VALUES ('turn-target', 1, 'work-1');
      INSERT INTO btcc_guided_effects VALUES
        ('receipt-1', 'same-effect', 'work-1', 'applied',
          '{"receiptId":"receipt-1","identitySha256":"same-effect"}', 1),
        ('receipt-2', 'same-effect', 'work-1', 'applied',
          '{"receiptId":"receipt-2","identitySha256":"same-effect"}', 2);
      INSERT INTO btcc_guided_work_review_revisions VALUES
        ('review-work-1-plan', 'work-1', 'plan', 1, '["preserve-intent"]', 'accept',
          'plan-2', NULL, NULL, NULL);
      INSERT INTO btcc_guided_work_plan_revisions VALUES
        ('plan-1', 'work-1', 1, 'objective', '["required-anchor"]', '[]', '[]'),
        ('plan-2', 'work-1', 2, 'objective', '[]', '[]', '[]');
      INSERT INTO btcc_guided_work_effect_blockers VALUES
        ('unresolved', 'turn-target', 'work-1');
      INSERT INTO btcc_guided_turn_work_bindings VALUES
        ('turn-preserved', 1, 'work-2');
      INSERT INTO btcc_guided_work_review_revisions VALUES
        ('review-work-2-plan', 'work-2', 'plan', 1, '["preserve-intent"]', 'accept',
          'plan-preserved', NULL, NULL, NULL);
      INSERT INTO btcc_guided_work_plan_revisions VALUES
        ('plan-preserved', 'work-2', 1, 'preserve-intent',
          '["required-anchor"]', '[]', '[]');
      INSERT INTO btcc_guided_turn_work_bindings VALUES
        ('turn-mismatched-binding', 1, 'work-3');
      INSERT INTO btcc_guided_work_review_revisions VALUES
        ('review-work-3-plan', 'work-3', 'plan', 1, '["preserve-intent"]', 'accept',
          'nonexistent-plan', NULL, NULL, NULL);
      INSERT INTO btcc_guided_work_plan_revisions VALUES
        ('actual-final-plan', 'work-3', 1, 'preserve-intent',
          '["required-anchor"]', '[]', '[]');
      INSERT INTO btcc_guided_turn_work_bindings VALUES
        ('turn-result-mismatched', 1, 'work-4');
      INSERT INTO btcc_guided_tool_calls VALUES
        ('result-call-4', 'turn-result-mismatched', 'read_file', 4,
          '{"value":"result-intent"}');
      INSERT INTO btcc_guided_work_results VALUES ('work-4', 1, 'result-call-4');
      INSERT INTO btcc_guided_work_plan_revisions VALUES
        ('plan-work-4', 'work-4', 1, 'objective', '[]', '[]', '[]');
      INSERT INTO btcc_guided_work_review_revisions VALUES
        ('review-work-4-result', 'work-4', 'result', 1,
          '["result-intent"]', 'accept', NULL, 999, NULL, NULL);
      INSERT INTO btcc_guided_turn_work_bindings VALUES
        ('turn-completion-mismatched', 1, 'work-5');
      INSERT INTO btcc_guided_tool_calls VALUES
        ('result-call-5', 'turn-completion-mismatched', 'write_file', 5,
          '{"value":"completion-intent"}');
      INSERT INTO btcc_guided_work_results VALUES ('work-5', 1, 'result-call-5');
      INSERT INTO btcc_guided_work_plan_revisions VALUES
        ('plan-work-5', 'work-5', 1, 'completion-intent', '[]', '[]', '[]');
      INSERT INTO btcc_guided_work_checkpoint_revisions VALUES
        ('work-5', 1, '[{"actionKey":"actual"}]');
      INSERT INTO btcc_guided_work_review_revisions VALUES
        ('actual-result-review-5', 'work-5', 'result', 1, '[]', 'accept',
          NULL, 1, NULL, NULL),
        ('completion-review-5', 'work-5', 'completion', 2,
          '["completion-intent"]', 'accept', 'plan-work-5', 1,
          'bogus-result-review', '[{"actionKey":"bogus"}]');
      INSERT INTO btcc_guided_effects VALUES
        ('receipt-5', 'identity-5', 'work-5', 'applied',
          '{"receiptId":"wrong","identitySha256":"identity-5","value":"completion-intent"}', 1);
    `);
    db.close();
    expect(readM1V2DbEvidence(root, "turn-target")).toMatchObject({
      quickCheckDatabases: 1,
      quickCheckPassed: true,
      toolCalls: 2,
      webToolCalls: 2,
      buildCommandToolCalls: 0,
      duplicateAppliedEffects: 1,
      unresolvedCorrections: 1,
      lostRequiredAnchors: 2,
    });
    expect(readM1V2DbEvidence(root, "turn-preserved")).toMatchObject({
      duplicateAppliedEffects: 0,
      unresolvedCorrections: 0,
      lostRequiredAnchors: 0,
    });
    expect(JSON.stringify(readM1V2DbEvidence(root, "turn-target")))
      .not.toContain("preserve-intent");
    expect(readM1V2DbEvidence(root, "turn-mismatched-binding")).toMatchObject({
      unresolvedCorrections: 1,
      lostRequiredAnchors: 0,
    });
    expect(readM1V2DbEvidence(root, "turn-result-mismatched")).toMatchObject({
      unresolvedCorrections: 1,
    });
    expect(readM1V2DbEvidence(root, "turn-completion-mismatched")).toMatchObject({
      unresolvedCorrections: 1,
    });
  });
});

function evidence(stepId: string, finalText: string): Record<string, unknown> {
  return {
    ok: true,
    run: { workspaceRoot: "/run/workspace" },
    isolation: {
      bindingWorkspace: "/run/workspace",
      workspaceInsideRunRoot: true,
      sourceDataIsRunData: false,
    },
    observations: [{
      stepId,
      turnId: `turn-${stepId}`,
      terminalState: "delivered",
      finalText,
      providerReportedModel: "gpt-5.6-sol",
      providerAgentModels: ["gpt-5.6-sol"],
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
        appliedEffectCapabilities: ["write_file"],
      },
    }],
    providerRequests: [{
      attemptDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      requestKind: "agent",
      requestStartedAtMs: 130,
      firstContentBearingDeltaAtMs: 20,
      completedAtMs: 150,
      terminatedAtMs: 150,
      serializedRequestBytes: 100,
      ordinal: 1,
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
    duplicateAppliedEffects: 0,
    unresolvedCorrections: 0,
    lostRequiredAnchors: 0,
    ...overrides,
  };
}

function approvedClaims(passed: boolean): M1V2ApprovedCapabilityClaim[] {
  return ([
    "butler.durable_project_work.v1",
    "butler.memory_context.v1",
    "butler.tools_workspace_authority.v1",
    "butler.provider_routing.v1",
    "butler.recovery.v1",
  ] as const).map((id) => ({
    id,
    requiredElementsPresent: [passed],
    negated: !passed,
    misrepresented: false,
    passed,
  }));
}
