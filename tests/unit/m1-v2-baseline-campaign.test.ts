import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationalMetricEvent } from
  "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import { assessM1V2Repetition } from
  "../support/m1-v2-baseline/assess.ts";
import { buildCampaignResult } from
  "../support/m1-v2-baseline/aggregate.ts";
import { loadCanonicalM1V2Fixtures } from
  "../support/m1-v2-baseline/fixtures.ts";
import { runM1V2BaselineCampaign } from
  "../support/m1-v2-baseline/runner.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("M1 v2 canonical baseline campaign", () => {
  test("pins public prompt and landing fixture bytes to authoritative provenance", () => {
    const fixtures = loadCanonicalM1V2Fixtures(process.cwd());
    expect(fixtures.map((fixture) => fixture.armId)).toEqual([
      "direct-cold",
      "direct-warm",
      "current-web-cold",
      "landing-cold",
    ]);
    for (const fixture of fixtures) {
      expect(fixture.scenario.model).toBe("openai/gpt-5.6-sol");
      expect(fixture.scenario.reasoningEffort).toBe("medium");
      expect(fixture.publicBenchmarkFixture).toBe(true);
      for (const step of fixture.scenario.steps) {
        expect(sha256(step.prompt)).toBe(fixture.promptSha256[step.id]);
      }
    }
    const warm = fixtures[1]!;
    expect(warm.scenario.steps.map((step) => step.id)).toEqual([
      "warmup",
      "direct-warm",
    ]);
    expect(warm.scenario.cacheBoundaryEvidence).toEqual({
      expectedRevision: "m1-v2-direct-warm-session-v2",
      observedRevision: "m1-v2-direct-warm-session-v2",
    });
    const landing = fixtures[3]!;
    expect(Object.fromEntries((landing.scenario.fixtures ?? []).map((fixture) => [
      fixture.path,
      sha256(fixture.text),
    ]))).toEqual(landing.fixtureSha256);

    const provenance = JSON.parse(readFileSync(join(
      process.cwd(),
      "tests/support/m1-v2-baseline/provenance.json",
    ), "utf8")) as { fixturePolicy: Record<string, unknown>; toolCalls: unknown[] };
    expect(provenance.fixturePolicy).toMatchObject({
      checkedInPromptsArePublicBenchmarkFixtures: true,
      originalReasoningEffort: "low",
      canonicalReasoningEffort: "medium",
      promptAndLandingFixtureBytesChanged: false,
    });
    expect(provenance.toolCalls).toHaveLength(4);
  });

  test("accepts only exact eligible target attempts and keeps nullable usage", () => {
    const evidence = directEvidence("hello");
    const metrics = attemptMetrics({
      armId: "direct-cold",
      submittedAtMs: 100,
      providerSendBytes: 100,
      segments: [
        ["current_user_request", 30],
        ["stable_safety_and_role_instructions", 40],
        ["provider_carrier_overhead", 29],
        ["other_typed_context", 1],
      ],
      usage: "usage_bearing",
    });
    const result = assessM1V2Repetition({
      armId: "direct-cold",
      evidence,
      metrics,
      targetStepId: "direct-cold",
      db: {
        quickCheckDatabases: 1,
        quickCheckPassed: true,
        toolCalls: 0,
        webToolCalls: 0,
        pagePreviewToolCalls: 0,
        buildCommandToolCalls: 0,
        fileMutationToolCalls: 0,
      },
    });
    expect(result.status).toBe("accepted");
    expect(result.agentAttempts).toHaveLength(1);
    expect(result.agentAttempts[0]).toMatchObject({
      exactByteSum: true,
      responseUsageStatus: "usage_bearing",
      otherShare: 0.01,
    });
    expect(result.quality).toMatchObject({ conciseGreeting: true });
    expect(result.unarmedPhysicalOverhead).toEqual({
      auxiliary: { attempts: 1, providerSendBytes: 30 },
      title: { attempts: 1, providerSendBytes: 20 },
      toolProvider: { attempts: 1, providerSendBytes: 40 },
    });
    expect(JSON.stringify(result)).not.toContain("hello");

    const aggregate = buildCampaignResult(1, [result]).arms[0]!;
    expect(aggregate.responseUsage).toMatchObject({
      promptTokens: { available: 1, unavailable: 0, median: 80, min: 80, max: 80 },
      cacheReadTokens: { available: 0, unavailable: 1, median: null },
      totalTokens: { available: 1, unavailable: 0, median: 90, min: 90, max: 90 },
    });
    expect(aggregate.unarmedPhysicalOverhead).toMatchObject({
      auxiliary: { attempts: 1, providerSendBytes: 30 },
      title: { attempts: 1, providerSendBytes: 20 },
      toolProvider: { attempts: 1, providerSendBytes: 40 },
    });
  });

  test("rejects retry contamination and other over two percent without substitution", () => {
    const result = assessM1V2Repetition({
      armId: "direct-cold",
      evidence: directEvidence("hello"),
      metrics: attemptMetrics({
        armId: "direct-cold",
        submittedAtMs: 100,
        providerSendBytes: 100,
        eligibility: "retry_contaminated",
        retryOrdinal: 1,
        segments: [
          ["current_user_request", 95],
          ["other_typed_context", 5],
        ],
      }),
      targetStepId: "direct-cold",
      db: {
        quickCheckDatabases: 1,
        quickCheckPassed: true,
        toolCalls: 0,
        webToolCalls: 0,
        pagePreviewToolCalls: 0,
        buildCommandToolCalls: 0,
        fileMutationToolCalls: 0,
      },
    });
    expect(result.status).toBe("rejected");
    expect(result.reasons).toContain("retry_contaminated");
    expect(result.reasons).toContain("other_typed_context_above_2_percent");
    expect(buildCampaignResult(1, [result]).arms[0]?.retry).toMatchObject({
      physicalAttempts: 1,
      contaminatedAttempts: 1,
      rate: 1,
      providerSendBytes: 100,
    });
  });

  test("runs four by three sequential fresh roots and preserves every status", async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "m1-v2-campaign-test-"));
    roots.push(outputRoot);
    let active = 0;
    let peak = 0;
    const seenRoots: string[] = [];
    const result = await runM1V2BaselineCampaign({
      outputRoot,
      repetitions: 3,
      repoRoot: process.cwd(),
      sourceData: "/source-data",
    }, {
      runHarness: async (scenario, options) => {
        active += 1;
        peak = Math.max(peak, active);
        seenRoots.push(options.runRoot!);
        await Promise.resolve();
        active -= 1;
        return directEvidence("not persisted", scenario.steps.at(-1)!.id, options.runRoot!);
      },
      readMetrics: () => attemptMetrics({
        armId: "direct-cold",
        submittedAtMs: 100,
        providerSendBytes: 100,
        segments: [["provider_carrier_overhead", 100]],
      }),
      assess: (input) => ({
        ...assessM1V2Repetition(input),
        status: input.armId === "landing-cold" ? "gated" : "accepted",
        reasons: input.armId === "landing-cold" ? ["fixture_gate"] : [],
      }),
      validateLanding: async () => null,
    });
    expect(peak).toBe(1);
    expect(seenRoots).toHaveLength(12);
    expect(new Set(seenRoots).size).toBe(12);
    expect(result.counts).toEqual({ accepted: 9, rejected: 0, gated: 3 });
    expect(result.repetitions).toHaveLength(12);
    expect(JSON.stringify(result)).not.toContain("not persisted");
    expect(JSON.stringify(result)).not.toContain(outputRoot);
    expect(JSON.stringify(result)).not.toContain("/source-data");
    expect(result.complete).toBe(false);
    expect(JSON.parse(readFileSync(join(outputRoot, "manifest.json"), "utf8"))).toMatchObject({
      retryPolicy: {
        providerApiMaxAttempts: 3,
        routeRetryCeiling: 3,
        retryContaminatedAccepted: false,
        replacementRunsAllowed: false,
      },
      cachePolicy: {
        directWarmSameSession: true,
        expectedObservedBoundaryMustMatch: true,
      },
      observerOnly: true,
    });
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function directEvidence(
  finalText: string,
  stepId = "direct-cold",
  runRoot = "/run",
): Record<string, unknown> {
  return {
    ok: true,
    run: { dataRoot: `${runRoot}/data`, runRoot, workspaceRoot: `${runRoot}/workspace` },
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
        terminalAtMs: 200,
        elapsedMs: 100,
      },
      expectations: { passed: true, failures: [] },
      reload: { tested: true, finalMatched: true },
      screenshots: [],
      work: null,
    }],
    providerRequests: [{
      ordinal: 1,
      requestKind: "agent",
      requestStartedAtMs: 130,
      firstContentBearingDeltaAtMs: 10,
      termination: "completed",
      status: 200,
      serializedRequestBytes: 100,
    }, {
      requestKind: "title",
      requestStartedAtMs: 140,
      firstContentBearingDeltaAtMs: 5,
      serializedRequestBytes: 20,
    }, {
      requestKind: "auxiliary",
      requestStartedAtMs: 150,
      firstContentBearingDeltaAtMs: 5,
      serializedRequestBytes: 30,
    }, {
      requestKind: "tool_provider",
      requestStartedAtMs: 160,
      firstContentBearingDeltaAtMs: 5,
      serializedRequestBytes: 40,
    }],
  };
}

function attemptMetrics(input: {
  armId: string;
  submittedAtMs: number;
  providerSendBytes: number;
  eligibility?: string;
  retryOrdinal?: number;
  segments: Array<[string, number]>;
  usage?: "usage_bearing" | null;
}): OperationalMetricEvent[] {
  const attemptDigest = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const envelope = metric(input.submittedAtMs + 30, "m1_v2_request_envelope", {
    attemptDigest,
    armId: input.armId,
    providerSendBytes: input.providerSendBytes,
    eligibility: input.eligibility ?? "eligible",
    retryOrdinal: input.retryOrdinal ?? 0,
    roundIndex: 0,
  });
  const segments = input.segments.map(([kind, providerSendBytes], index) =>
    metric(input.submittedAtMs + 30, "m1_v2_request_segment", {
      attemptDigest,
      segmentId: `segment-${index}`,
      kind,
      stability: kind.startsWith("stable_") ? "stable" : "dynamic",
      providerSendBytes,
      keyedContentDigest: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    }));
  const usage = metric(input.submittedAtMs + 40, "m1_v2_response_usage", {
    attemptDigest,
    status: input.usage ?? "unavailable",
    promptTokens: input.usage ? 80 : null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: input.usage ? 10 : null,
    reasoningTokens: null,
    totalTokens: input.usage ? 90 : null,
  });
  return [envelope, ...segments, usage];
}

function metric(
  ts: number,
  name: string,
  dimensions: Record<string, string | number | boolean | null>,
): OperationalMetricEvent {
  return {
    schema: "butler.operational-metric.v1",
    ts,
    category: "context",
    name,
    status: "ok",
    dimensions,
    rawTextStored: false,
  };
}
