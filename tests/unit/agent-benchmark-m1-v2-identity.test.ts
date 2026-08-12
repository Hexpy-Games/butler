import { afterAll, describe, expect, test } from "bun:test";
import type { OperationalMetricEvent } from
  "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import { summarizePhysicalRequests } from
  "../support/agent-benchmark/m1-v2-evidence-summary.ts";
import { m1V2EvidenceIdentityReasons } from
  "../support/agent-benchmark/m1-v2-identity.ts";
import { evaluateAdapterResult } from
  "../support/agent-benchmark/evaluators.ts";
import type { AdapterRunResult } from
  "../support/agent-benchmark/contracts.ts";
import { providerRequestTurnIdentities } from
  "../e2e/btcc-r3-electron/provider-request-turn-identity.ts";
import { getBenchmarkFixture } from
  "../support/agent-benchmark/fixtures.ts";
import { createBenchmarkPlan } from
  "../support/agent-benchmark/planning.ts";
import { prepareTestHarnessAuthority } from
  "./support/m1-v2-provenance-authority.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const attemptA = "A".repeat(43);
const attemptB = "B".repeat(43);
const titleAttempt = "T".repeat(43);
const authorityRoot = mkdtempSync(join(tmpdir(), "agent-benchmark-identity-"));
const authority = prepareTestHarnessAuthority(authorityRoot);
afterAll(() => rmSync(authorityRoot, { force: true, recursive: true }));

interface TestProviderRequest extends Record<string, unknown> {
  ordinal: number;
  attemptDigest: string | null;
  requestKind: "agent" | "auxiliary" | "title" | "tool_provider";
  serializedRequestBytes: number;
  requestStartedAtMs: number;
  firstContentBearingDeltaAtMs: number | null;
  completedAtMs: number;
  terminatedAtMs: number;
}

describe("M1 v2 product-owned evidence identity", () => {
  test("accepts the exact clean Electron product session instead of reconstructing it from arm.key", () => {
    const { arm, fixture } = identityFixture();
    const sessionId = "chat-btcc-r3-e2e-agent-benchmark-direct-cold-controlled-rep-1";
    const turnId = "turn-product-owned";
    const evidence = productEvidence({ armRoot: arm.evidenceRoot, fixture, sessionId, turnId });

    expect(m1V2EvidenceIdentityReasons({
      arm,
      fixture,
      evidence,
      attemptStartedAtMs: Date.parse("2026-08-12T00:00:00.000Z"),
    })).toEqual([]);
  });

  test("rejects stale evidence and a target observation owned by another session", () => {
    const { arm, fixture } = identityFixture();
    const evidence = productEvidence({
      armRoot: arm.evidenceRoot,
      fixture,
      sessionId: "chat-btcc-r3-e2e-agent-benchmark-direct-cold-controlled-rep-1",
      turnId: "turn-product-owned",
    });
    const target = (evidence.observations as Record<string, unknown>[])[0]!;
    target.sessionId = "chat-other-session";
    evidence.generatedAt = "2026-08-11T23:59:00.000Z";

    expect(m1V2EvidenceIdentityReasons({
      arm,
      fixture,
      evidence,
      attemptStartedAtMs: Date.parse("2026-08-12T00:00:00.000Z"),
    })).toEqual(expect.arrayContaining([
      "evidence_target_session_identity_mismatch",
      "stale_evidence_mismatch",
    ]));
  });

  test("joins only target Agent attempts while preserving typed title and auxiliary overhead", () => {
    const sessionId = "chat-btcc-r3-e2e-agent-benchmark-direct-cold-controlled-rep-1";
    const turnId = "turn-product-owned";
    const requests = [
      request(1, titleAttempt, "title", 17, 110),
      request(2, null, "auxiliary", 23, 120),
      request(3, attemptA, "agent", 100, 130),
    ];
    const summary = summarizePhysicalRequests(
      requests,
      [
        envelope(titleAttempt, 17, 115, 0, null),
        envelope(attemptA, 100, 140, 0),
      ],
      "direct-cold",
      {
        sessionId,
        turnId,
        providerRequestIdentities: [
          ownership(1, sessionId, turnId, "title", titleAttempt),
          ownership(2, sessionId, turnId, "auxiliary", null),
          ownership(3, sessionId, turnId, "agent", attemptA),
        ],
      },
    );

    expect(summary).toMatchObject({
      auxiliary: { attempts: 1, providerSendBytes: 23 },
      title: { attempts: 1, providerSendBytes: 17 },
      unmatchedEnvelopeDigests: [],
      unmatchedRequestOrdinals: [],
      invalidRequestIdentityCount: 0,
    });
  });

  test("uses the direct-warm Step identity snapshot when prior title overlaps the target interval", () => {
    const sessionId = "chat-product-session";
    const targetTurnId = "turn-direct-warm";
    const priorAgent = timedRequest(1, attemptB, "agent", 80, 90, 100, 100);
    const overlappingPriorTitle = timedRequest(
      2, titleAttempt, "title", 17, 90, 130, 130,
    );
    const targetAuxiliary = timedRequest(3, null, "auxiliary", 23, 105, 115, 115);
    const targetAgent = timedRequest(4, attemptA, "agent", 100, 110, 150, 150);
    const targetTitleAttempt = "U".repeat(43);
    const targetTitle = timedRequest(
      5, targetTitleAttempt, "title", 19, 155, 165, 165,
    );
    const allRequests = [
      priorAgent,
      overlappingPriorTitle,
      targetAuxiliary,
      targetAgent,
      targetTitle,
    ];
    const targetIdentities = providerRequestTurnIdentities({
      requests: allRequests,
      ordinalsBeforeSubmission: new Set([1, 2]),
      sessionId,
      turnId: targetTurnId,
    });

    expect(targetIdentities.map((identity) => identity.ordinal)).toEqual([3, 4, 5]);
    const evaluated = evaluateProductEvidence({
      fixtureId: "direct-warm",
      requests: allRequests,
      identities: targetIdentities,
      metrics: [
        ...attemptMetrics(attemptA, 100, 0, "eligible", "direct-warm"),
        envelope(titleAttempt, 17, 130, 0, null),
        envelope(targetTitleAttempt, 19, 165, 0, null),
      ],
      sessionId,
      turnId: targetTurnId,
    });

    expect(evaluated.m1V2?.reasons).not.toContain(
      "physical_attempt_identity_join_failed",
    );
    expect(evaluated.terminalState).toBe("accepted");
    expect(evaluated.m1V2).toMatchObject({
      agentAttempts: [{ providerSendBytes: 100 }],
      auxiliaryPhysicalAttempts: 1,
      titlePhysicalAttempts: 2,
    });
  });

  test.each([
    ["end-before", 80, 95],
    ["start-during", 120, 130],
  ] as const)("keeps %s unarmed campaign title overhead outside target Agent ownership", (
    _boundary,
    startedAtMs,
    terminatedAtMs,
  ) => {
    const sessionId = "chat-product-session";
    const turnId = "turn-product-owned";
    const campaignTitle = timedRequest(
      1, titleAttempt, "title", 17, startedAtMs, terminatedAtMs, terminatedAtMs,
    );
    const targetAgent = timedRequest(2, attemptA, "agent", 100, 110, 150, 150);
    const identities = providerRequestTurnIdentities({
      requests: [campaignTitle, targetAgent],
      ordinalsBeforeSubmission: new Set([1]),
      sessionId,
      turnId,
    });
    const summary = summarizePhysicalRequests(
      [campaignTitle, targetAgent],
      [
        envelope(titleAttempt, 17, terminatedAtMs, 0, null),
        envelope(attemptA, 100, 150, 0),
      ],
      "direct-cold",
      { sessionId, turnId, providerRequestIdentities: identities },
    );

    expect(summary).toMatchObject({
      title: { attempts: 1, providerSendBytes: 17 },
      unmatchedEnvelopeDigests: [],
      unmatchedRequestOrdinals: [],
      invalidRequestIdentityCount: 0,
    });
  });

  test("fails closed on missing, duplicate, and conflicting target identity membership", () => {
    const sessionId = "chat-product-session";
    const turnId = "turn-product-owned";
    const agent = request(4, attemptA, "agent", 100, 150);
    const matchingEnvelope = envelope(attemptA, 100, 150, 0);
    const cases = [
      [ownership(4, sessionId, turnId, "agent", attemptA)],
      [
        ownership(4, sessionId, turnId, "agent", attemptA),
        ownership(4, sessionId, turnId, "agent", attemptA),
      ],
      [
        ownership(4, sessionId, turnId, "agent", attemptA),
        ownership(5, sessionId, turnId, "title", attemptA),
      ],
    ];
    const requests = [[], [agent], [agent, request(5, attemptA, "title", 17, 155)]];

    for (let index = 0; index < cases.length; index += 1) {
      const summary = summarizePhysicalRequests(
        requests[index]!,
        [matchingEnvelope],
        "direct-cold",
        { sessionId, turnId, providerRequestIdentities: cases[index]! },
      );
      expect(summary.invalidRequestIdentityCount).toBeGreaterThan(0);
    }
  });

  test("joins every retry physical attempt exactly and fails closed on a wrong attempt identity", () => {
    const sessionId = "chat-btcc-r3-e2e-agent-benchmark-direct-cold-controlled-rep-1";
    const turnId = "turn-product-owned";
    const requests = [
      request(1, attemptA, "agent", 100, 130),
      request(2, attemptB, "agent", 120, 150),
    ];
    const envelopes = [
      envelope(attemptA, 100, 140, 0),
      envelope(attemptB, 120, 160, 1),
    ];
    const exact = summarizePhysicalRequests(requests, envelopes, "direct-cold", {
      sessionId,
      turnId,
      providerRequestIdentities: [
        ownership(1, sessionId, turnId, "agent", attemptA),
        ownership(2, sessionId, turnId, "agent", attemptB),
      ],
    });
    expect(exact).toMatchObject({
      unmatchedEnvelopeDigests: [],
      unmatchedRequestOrdinals: [],
      invalidRequestIdentityCount: 0,
    });

    const wrong = summarizePhysicalRequests(requests, envelopes, "direct-cold", {
      sessionId,
      turnId,
      providerRequestIdentities: [
        ownership(1, sessionId, turnId, "agent", attemptA),
        ownership(2, sessionId, turnId, "agent", "C".repeat(43)),
      ],
    });
    expect(wrong.invalidRequestIdentityCount).toBeGreaterThan(0);
    expect(wrong.unmatchedEnvelopeDigests).toContain(attemptB);
  });

  test.each([
    ["bytes", envelope(attemptA, 99, 150, 0)],
    ["terminal time", envelope(attemptA, 100, 5_151, 0)],
    ["arm", envelope(attemptA, 100, 150, 0, null)],
  ] as const)("fails closed when target Agent %s corroboration differs", (
    _field,
    observedEnvelope,
  ) => {
    const sessionId = "chat-product-session";
    const turnId = "turn-product-owned";
    const summary = summarizePhysicalRequests(
      [request(4, attemptA, "agent", 100, 150)],
      [observedEnvelope],
      "direct-cold",
      {
        sessionId,
        turnId,
        providerRequestIdentities: [
          ownership(4, sessionId, turnId, "agent", attemptA),
        ],
      },
    );

    if (_field === "arm") {
      expect(summary.unmatchedEnvelopeDigests).toContain(attemptA);
    } else {
      expect(summary.unmatchedRequestOrdinals).toContain(4);
      expect(summary.unmatchedEnvelopeDigests).toContain(attemptA);
    }
  });

  test("excludes late typed non-Agent requests that are absent from the target ownership snapshot", () => {
    const sessionId = "chat-btcc-r3-e2e-agent-benchmark-direct-cold-controlled-rep-1";
    const turnId = "turn-product-owned";
    const requests = [
      request(1, attemptA, "agent", 100, 130),
      request(2, titleAttempt, "title", 17, 205),
      request(3, null, "auxiliary", 23, 210),
      request(4, null, "tool_provider", 31, 215),
    ];
    const summary = summarizePhysicalRequests(
      requests,
      [
        envelope(attemptA, 100, 140, 0),
        envelope(titleAttempt, 17, 210, 0, null),
      ],
      "direct-cold",
      {
        sessionId,
        turnId,
        providerRequestIdentities: [
          ownership(1, sessionId, turnId, "agent", attemptA),
        ],
      },
    );

    expect(summary).toMatchObject({
      auxiliary: { attempts: 1, providerSendBytes: 23 },
      title: { attempts: 1, providerSendBytes: 17 },
      toolProvider: { attempts: 1, providerSendBytes: 31 },
      unmatchedEnvelopeDigests: [],
      unmatchedRequestOrdinals: [],
      invalidRequestIdentityCount: 0,
    });
  });

  test("rejects a typed non-Agent envelope carrying the target arm", () => {
    const sessionId = "chat-product-session";
    const turnId = "turn-product-owned";
    const summary = summarizePhysicalRequests(
      [
        request(1, attemptA, "agent", 100, 130),
        request(2, titleAttempt, "title", 17, 150),
      ],
      [
        envelope(attemptA, 100, 140, 0),
        envelope(titleAttempt, 17, 160, 0, "direct-cold"),
      ],
      "direct-cold",
      {
        sessionId,
        turnId,
        providerRequestIdentities: [
          ownership(1, sessionId, turnId, "agent", attemptA),
        ],
      },
    );

    expect(summary.unmatchedEnvelopeDigests).toContain(titleAttempt);
  });

  test.each([
    ["session", "chat-wrong-session", "turn-product-owned", attemptA],
    ["turn", "chat-product-session", "turn-wrong", attemptA],
    ["attempt", "chat-product-session", "turn-product-owned", attemptB],
  ] as const)("fails closed on wrong target Agent %s identity", (
    _kind,
    ownedSessionId,
    ownedTurnId,
    ownedAttempt,
  ) => {
    const sessionId = "chat-product-session";
    const turnId = "turn-product-owned";
    const summary = summarizePhysicalRequests(
      [request(1, attemptA, "agent", 100, 130)],
      [envelope(attemptA, 100, 140, 0)],
      "direct-cold",
      {
        sessionId,
        turnId,
        providerRequestIdentities: [
          ownership(1, ownedSessionId, ownedTurnId, "agent", ownedAttempt),
        ],
      },
    );

    expect(summary.invalidRequestIdentityCount).toBeGreaterThan(0);
    expect(summary.unmatchedEnvelopeDigests).toContain(attemptA);
    expect(summary.unmatchedRequestOrdinals).toContain(1);
  });

  test("carries the real driver primitive through evaluator clean, retry, wrong identity, late overhead, and arm rejection paths", () => {
    const sessionId = "chat-product-session";
    const turnId = "turn-product-owned";
    const agentA = request(1, attemptA, "agent", 100, 130);
    const agentB = request(2, attemptB, "agent", 120, 160);
    const cleanIdentities = providerRequestTurnIdentities({
      requests: [agentA],
      ordinalsBeforeSubmission: new Set(),
      sessionId,
      turnId,
    });
    const clean = evaluateProductEvidence({
      requests: [agentA],
      identities: cleanIdentities,
      metrics: attemptMetrics(attemptA, 100, 0, "eligible"),
      sessionId,
      turnId,
    });
    expect(clean.terminalState).toBe("accepted");

    const retry = evaluateProductEvidence({
      requests: [agentA, agentB],
      identities: providerRequestTurnIdentities({
        requests: [agentA, agentB],
        ordinalsBeforeSubmission: new Set(),
        sessionId,
        turnId,
      }),
      metrics: [
        ...attemptMetrics(attemptA, 100, 0, "retry_contaminated"),
        ...attemptMetrics(attemptB, 120, 1, "eligible"),
      ],
      sessionId,
      turnId,
    });
    expect(retry.m1V2?.agentAttempts).toHaveLength(2);
    expect(retry.m1V2?.reasons).toContain("retry_contaminated");
    expect(retry.m1V2?.reasons).not.toContain("physical_attempt_identity_join_failed");

    for (const corrupt of [
      { ...cleanIdentities[0]!, sessionId: "chat-wrong" },
      { ...cleanIdentities[0]!, turnId: "turn-wrong" },
      { ...cleanIdentities[0]!, attemptDigest: attemptB },
    ]) {
      const wrong = evaluateProductEvidence({
        requests: [agentA], metrics: attemptMetrics(attemptA, 100, 0, "eligible"),
        identities: [corrupt], sessionId, turnId,
      });
      expect(wrong.m1V2?.reasons).toContain("physical_attempt_identity_join_failed");
    }

    const lateTitle = request(2, titleAttempt, "title", 17, 205);
    const lateAuxiliary = request(3, null, "auxiliary", 23, 205);
    const late = evaluateProductEvidence({
      requests: [agentA, lateTitle, lateAuxiliary],
      identities: cleanIdentities,
      metrics: [
        ...attemptMetrics(attemptA, 100, 0, "eligible"),
        ...attemptMetrics(titleAttempt, 17, 0, "eligible", null),
      ],
      sessionId,
      turnId,
    });
    expect(late.terminalState).toBe("accepted");
    expect(late.m1V2).toMatchObject({
      titlePhysicalAttempts: 1,
      auxiliaryPhysicalAttempts: 1,
    });

    const armTaggedTitle = evaluateProductEvidence({
      requests: [agentA, lateTitle],
      identities: cleanIdentities,
      metrics: [
        ...attemptMetrics(attemptA, 100, 0, "eligible"),
        ...attemptMetrics(titleAttempt, 17, 0, "eligible", "direct-cold"),
      ],
      sessionId,
      turnId,
    });
    expect(armTaggedTitle.m1V2?.reasons)
      .toContain("physical_attempt_identity_join_failed");
  });
});

function identityFixture(fixtureId: "direct-cold" | "direct-warm" = "direct-cold") {
  const plan = createBenchmarkPlan({
    campaign: "m1-v2", runId: "identity", seed: 1,
    runRoot: join(authorityRoot, "run"), sourceRoot: process.cwd(),
    harnessRoot: authority.harnessRoot, provenanceJsonlPath: authority.jsonlPath,
    baselineSha: "a".repeat(40), controlledModel: "openai/gpt-5.6-sol",
    controlledReasoning: "medium",
  });
  const arm = plan.arms.find((candidate) => candidate.scenario === fixtureId);
  if (!arm) throw new Error(`Missing ${fixtureId} test arm`);
  return { arm, fixture: getBenchmarkFixture(fixtureId) };
}

function productEvidence(input: {
  armRoot: string;
  fixture: ReturnType<typeof getBenchmarkFixture>;
  sessionId: string;
  turnId: string;
}): Record<string, unknown> {
  return {
    ok: true,
    generatedAt: "2026-08-12T00:00:01.000Z",
    run: {
      runRoot: input.armRoot,
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "medium",
    },
    session: { id: input.sessionId },
    observations: [{
      stepId: "direct-cold",
      sessionId: input.sessionId,
      turnId: input.turnId,
      promptSha256: input.fixture.m1V2!.promptSha256["direct-cold"],
    }],
  };
}

function request(
  ordinal: number,
  attemptDigest: string | null,
  requestKind: "agent" | "auxiliary" | "title" | "tool_provider",
  serializedRequestBytes: number,
  completedAtMs: number,
): TestProviderRequest {
  return {
    ordinal,
    attemptDigest,
    requestKind,
    serializedRequestBytes,
    requestStartedAtMs: completedAtMs - 10,
    firstContentBearingDeltaAtMs: requestKind === "agent" ? 5 : null,
    completedAtMs,
    terminatedAtMs: completedAtMs,
  };
}

function timedRequest(
  ordinal: number,
  attemptDigest: string | null,
  requestKind: TestProviderRequest["requestKind"],
  serializedRequestBytes: number,
  requestStartedAtMs: number,
  completedAtMs: number,
  terminatedAtMs: number,
): TestProviderRequest {
  return {
    ordinal,
    attemptDigest,
    requestKind,
    serializedRequestBytes,
    requestStartedAtMs,
    firstContentBearingDeltaAtMs: requestKind === "agent" ? 5 : null,
    completedAtMs,
    terminatedAtMs,
  };
}

function ownership(
  ordinal: number,
  sessionId: string,
  turnId: string,
  requestKind: "agent" | "auxiliary" | "title",
  attemptDigest: string | null,
) {
  return { ordinal, sessionId, turnId, requestKind, attemptDigest };
}

function envelope(
  attemptDigest: string,
  providerSendBytes: number,
  ts: number,
  retryOrdinal: number,
  armId: "direct-cold" | "direct-warm" | null = "direct-cold",
): OperationalMetricEvent {
  return {
    schema: "butler.operational-metric.v1",
    ts,
    category: "context",
    name: "m1_v2_request_envelope",
    status: "ok",
    dimensions: {
      attemptDigest,
      armId,
      providerSendBytes,
      retryOrdinal,
    },
    rawTextStored: false,
  };
}

function attemptMetrics(
  attemptDigest: string,
  bytes: number,
  retryOrdinal: number,
  eligibility: string,
  armId: "direct-cold" | "direct-warm" | null = "direct-cold",
): OperationalMetricEvent[] {
  return [
    envelope(attemptDigest, bytes, 150 + retryOrdinal, retryOrdinal, armId),
    metric("m1_v2_request_segment", {
      attemptDigest,
      segmentId: `segment-${attemptDigest}`,
      kind: "provider_carrier_overhead",
      stability: "dynamic",
      providerSendBytes: bytes,
      keyedContentDigest: "K".repeat(43),
    }),
    metric("m1_v2_response_usage", {
      attemptDigest,
      status: "unavailable",
      promptTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
    }),
  ].map((event) => event.name === "m1_v2_request_envelope"
    ? { ...event, dimensions: { ...event.dimensions, eligibility } }
    : event);
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

function evaluateProductEvidence(input: {
  fixtureId?: "direct-cold" | "direct-warm";
  requests: ReturnType<typeof request>[];
  identities: ReturnType<typeof providerRequestTurnIdentities>;
  metrics: OperationalMetricEvent[];
  sessionId: string;
  turnId: string;
}) {
  const fixtureId = input.fixtureId ?? "direct-cold";
  const { arm, fixture } = identityFixture(fixtureId);
  const evidence = {
    ok: true,
    generatedAt: "2026-08-12T00:00:01.000Z",
    run: {
      runRoot: arm.evidenceRoot,
      workspaceRoot: `${arm.evidenceRoot}/workspace`,
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "medium",
    },
    isolation: {
      bindingWorkspace: `${arm.evidenceRoot}/workspace`,
      workspaceInsideRunRoot: true,
      sourceDataIsRunData: false,
    },
    session: { id: input.sessionId },
    observations: [{
      stepId: fixture.m1V2!.targetStepId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      providerRequestIdentities: input.identities,
      terminalState: "delivered",
      promptSha256: fixture.m1V2!.promptSha256[fixture.m1V2!.targetStepId],
      finalText: "안녕하세요.",
      providerReportedModel: "gpt-5.6-sol",
      providerAgentModels: ["gpt-5.6-sol"],
      timing: { submittedAtMs: 100, terminalAtMs: 200, elapsedMs: 100 },
      reload: { tested: true, finalMatched: true },
    }],
    providerRequests: input.requests,
  };
  const result: AdapterRunResult = {
    exitCode: 0,
    gateCode: "none",
    timedOut: false,
    cancelled: false,
    stdout: "",
    stderr: "",
    adapterVersion: "test",
    provider: "openai",
    finalText: "안녕하세요.",
    sessionId: input.sessionId,
    usage: {},
    tools: {},
    timing: {},
    operations: {},
    changedPaths: [],
    evidenceRefs: [],
    m1V2Evidence: {
      evidence,
      metrics: input.metrics.map((event) => event.name === "m1_v2_request_envelope"
        ? {
            ...event,
            dimensions: {
              ...event.dimensions,
              sourceRevision: "a".repeat(40),
              roundIndex: event.dimensions?.retryOrdinal ?? 0,
            },
          }
        : event),
      db: {
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
      },
      landingValidation: null,
      sourceRevision: "a".repeat(40),
      attemptStartedAtMs: Date.parse("2026-08-12T00:00:00.000Z"),
    },
  };
  return evaluateAdapterResult(arm, fixture, result);
}
