import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterRunResult } from "../support/agent-benchmark/contracts.ts";
import { createButlerAdapter } from "../support/agent-benchmark/butler-adapter.ts";
import {
  createBenchmarkPlan,
  evaluateAdapterResult,
  getBenchmarkFixture,
  loadM1V2BenchmarkFixtures,
  summarizeBenchmarkResult,
} from "../support/agent-benchmark/index.ts";
import { prepareTestHarnessAuthority } from "./support/m1-v2-provenance-authority.ts";

const authorityRoot = mkdtempSync(join(tmpdir(), "agent-benchmark-m1-authority-"));
const authority = prepareTestHarnessAuthority(authorityRoot);
afterAll(() => rmSync(authorityRoot, { force: true, recursive: true }));

describe("unified agent benchmark M1 v2 campaign", () => {
  test("uses the sole planner and fixture authority for the fixed four by three Butler campaign", () => {
    const plan = createBenchmarkPlan({
      campaign: "m1-v2",
      runId: "m1-v2-contract",
      seed: 20260812,
      runRoot: "/tmp/m1-v2-contract",
      sourceRoot: process.cwd(),
      harnessRoot: authority.harnessRoot,
      provenanceJsonlPath: authority.jsonlPath,
      baselineSha: "a".repeat(40),
      controlledModel: "openai/gpt-5.6-sol",
      controlledReasoning: "medium",
    });
    expect(plan.campaign).toBe("m1-v2");
    expect(plan.arms).toHaveLength(12);
    expect(new Set(plan.arms.map((arm) => arm.agent))).toEqual(new Set(["butler"]));
    expect(new Set(plan.arms.map((arm) => arm.evidenceRoot)).size).toBe(12);
    expect(plan.arms.map((arm) => arm.scenario)).toEqual([
      "direct-cold", "direct-cold", "direct-cold",
      "direct-warm", "direct-warm", "direct-warm",
      "current-web-cold", "current-web-cold", "current-web-cold",
      "landing-cold", "landing-cold", "landing-cold",
    ]);
    expect(plan.policy).toMatchObject({
      sequential: true,
      observerOnly: true,
      retryContaminatedAccepted: false,
      replacementRunsAllowed: false,
      directWarmSameSession: true,
      expectedObservedCacheBoundaryMustMatch: true,
    });
  });

  test("freezes exact prompt, landing, and direct-warm same-session boundaries", () => {
    const fixtures = loadM1V2BenchmarkFixtures(process.cwd());
    expect(fixtures.map((fixture) => fixture.id)).toEqual([
      "direct-cold", "direct-warm", "current-web-cold", "landing-cold",
    ]);
    expect(fixtures.find((fixture) => fixture.id === "direct-warm")?.m1V2?.scenario)
      .toMatchObject({
        attributionArmId: "direct-warm",
        cacheBoundaryEvidence: {
          expectedRevision: "m1-v2-direct-warm-session-v2",
          observedRevision: "m1-v2-direct-warm-session-v2",
        },
      });
    expect(fixtures.find((fixture) => fixture.id === "landing-cold")?.m1V2?.fixtureSha256)
      .toEqual({
        "package.json": "95ecbc5ceb44f1aef70447a3f32a53875f6ac518b3b6cc47d173cb6be7b15acc",
        "index.html": "a63afd07e728a2055133510f0cc1ad65140dd25ec495d342d6cce2e55d157dc1",
        "styles.css": "f5fcb45b67a99855be1a908025d8bbdd3685c788f1ee391e741c9d988629dcd1",
      });
  });

  test("has no parallel baseline domain, imports, runner, planner, or report authority", () => {
    const root = process.cwd();
    expect(existsSync(join(root, "tests/support/m1-v2-baseline"))).toBe(false);
    const publicSurface = readFileSync(join(root, "tests/support/agent-benchmark/index.ts"), "utf8");
    expect(publicSurface).not.toContain("runM1V2");
    expect(publicSurface).not.toContain("createM1V2");
    for (const path of [
      "tests/support/agent-benchmark/workflow.ts",
      "tests/support/agent-benchmark/planning.ts",
      "tests/support/agent-benchmark/report.ts",
    ]) {
      expect(readFileSync(join(root, path), "utf8")).not.toContain("m1-v2-baseline");
    }
    const butlerAdapter = readFileSync(join(root, "tests/support/agent-benchmark/butler-adapter.ts"), "utf8");
    expect(butlerAdapter).toContain("runBtccR3ElectronHarness");
    expect(butlerAdapter).toContain("../../e2e/btcc-r3-electron-harness.ts");
    expect(butlerAdapter).not.toMatch(/m1.*driver/iu);
  });

  test("turns a missing real Butler product receipt into an explicit gate", async () => {
    const plan = createBenchmarkPlan({
      campaign: "m1-v2", runId: "m1-v2-gate", seed: 2,
      runRoot: "/tmp/m1-v2-gate", sourceRoot: process.cwd(),
      harnessRoot: authority.harnessRoot, provenanceJsonlPath: authority.jsonlPath,
      baselineSha: "a".repeat(40), controlledModel: "openai/gpt-5.6-sol",
      controlledReasoning: "medium",
    });
    const arm = plan.arms[0]!;
    const fixture = getBenchmarkFixture(arm.scenario);
    const adapter = createButlerAdapter(async () => {
      throw new Error("Electron setup failed before evidence");
    }, process.cwd());
    const result = await adapter.run({
      arm, fixture, prompt: fixture.prompts.join("\n\n"), sessionId: null,
      sourceEvidenceRoot: "", runtimeInstructions: "", signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ exitCode: null, gateCode: "measurement_unavailable" });
    const observation = evaluateAdapterResult(arm, fixture, result);
    expect(observation).toMatchObject({
      terminalState: "gated",
      m1V2: { status: "gated", reasons: ["m1-v2-evidence-unavailable"] },
    });
  });

  test("accepts product-owned identity, preserves exact SC01 bytes and nullable usage, then fails closed on mismatches", () => {
    const plan = createBenchmarkPlan({
      campaign: "m1-v2", runId: "m1-v2-identity", seed: 1,
      runRoot: "/tmp/m1-v2-identity", sourceRoot: process.cwd(),
      harnessRoot: authority.harnessRoot, provenanceJsonlPath: authority.jsonlPath,
      baselineSha: "a".repeat(40), controlledModel: "openai/gpt-5.6-sol",
      controlledReasoning: "medium",
    });
    const arm = plan.arms[0]!;
    const fixture = getBenchmarkFixture("direct-cold");
    const attemptDigest = "A".repeat(43);
    const evidence = {
      ok: true,
      generatedAt: "2026-08-12T00:00:00.000Z",
      run: { runRoot: arm.evidenceRoot, workspaceRoot: `${arm.evidenceRoot}/workspace`, model: "openai/gpt-5.6-sol", reasoningEffort: "medium" },
      isolation: { bindingWorkspace: `${arm.evidenceRoot}/workspace`, workspaceInsideRunRoot: true, sourceDataIsRunData: false },
      session: { id: `chat-btcc-r3-e2e-agent-benchmark-${arm.key.replaceAll(":", "-")}` },
      observations: [{
        stepId: "direct-cold", sessionId: `chat-btcc-r3-e2e-agent-benchmark-${arm.key.replaceAll(":", "-")}`,
        turnId: "turn-direct", terminalState: "delivered",
        promptSha256: fixture.m1V2!.promptSha256["direct-cold"], finalText: "안녕하세요.",
        providerReportedModel: "gpt-5.6-sol", providerAgentModels: ["gpt-5.6-sol"],
        timing: { submittedAtMs: 100, terminalAtMs: 200, elapsedMs: 100 },
        reload: { tested: true, finalMatched: true },
        providerRequestIdentities: [{
          ordinal: 1,
          sessionId: `chat-btcc-r3-e2e-agent-benchmark-${arm.key.replaceAll(":", "-")}`,
          turnId: "turn-direct",
          requestKind: "agent",
          attemptDigest,
        }],
      }],
      providerRequests: [{ attemptDigest, requestKind: "agent", requestStartedAtMs: 120, completedAtMs: 150, terminatedAtMs: 150, serializedRequestBytes: 100, ordinal: 1, firstContentBearingDeltaAtMs: 5 }],
    };
    const metric = (name: string, dimensions: Record<string, string | number | boolean | null>) => ({
      schema: "butler.operational-metric.v1" as const, ts: 150, category: "context" as const,
      name, status: "ok" as const, dimensions, rawTextStored: false as const,
    });
    const adapterResult: AdapterRunResult = {
      exitCode: 0, gateCode: "none", timedOut: false, cancelled: false,
      stdout: "", stderr: "", adapterVersion: "test", provider: "openai",
      finalText: "안녕하세요.", sessionId: evidence.session.id, usage: {}, tools: {}, timing: {},
      operations: {}, changedPaths: [], evidenceRefs: [],
      m1V2Evidence: {
        evidence,
        metrics: [
          metric("m1_v2_request_envelope", { attemptDigest, armId: "direct-cold", sourceRevision: "a".repeat(40), providerSendBytes: 100, eligibility: "eligible", retryOrdinal: 0, roundIndex: 0 }),
          metric("m1_v2_request_segment", { attemptDigest, segmentId: "segment-1", kind: "provider_carrier_overhead", stability: "dynamic", providerSendBytes: 100, keyedContentDigest: "B".repeat(43) }),
          metric("m1_v2_response_usage", { attemptDigest, status: "unavailable", promptTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null }),
        ],
        db: { quickCheckDatabases: 1, quickCheckPassed: true, toolCalls: 0, webToolCalls: 0, pagePreviewToolCalls: 0, buildCommandToolCalls: 0, fileMutationToolCalls: 0, duplicateAppliedEffects: 0, unresolvedCorrections: 0, lostRequiredAnchors: 0 },
        landingValidation: null,
        sourceRevision: "a".repeat(40),
        attemptStartedAtMs: Date.parse("2026-08-12T00:00:00.000Z"),
      },
    };
    const accepted = evaluateAdapterResult(arm, fixture, adapterResult);
    expect(accepted.terminalState).toBe("accepted");
    expect(accepted.m1V2?.agentAttempts[0]).toMatchObject({
      exactByteSum: true,
      responseUsageStatus: "unavailable", promptTokens: null, totalTokens: null,
    });
    const pairedArm = { ...arm, version: "after" as const, pairId: "direct-cold:rep-1", block: 0,
      pairedExecution: { provider: "openai" as const, authMode: "managed" as const, model: "openai/gpt-5.6-sol" as const,
        reasoning: "medium" as const, executionMode: "ordinary_non_fast" as const, serviceTier: "default" as const,
        requestOption: { service_tier: "default" as const } } };
    const executionRejected = evaluateAdapterResult(pairedArm, fixture, { ...adapterResult,
      pairedExecutionEvidence: { provider: "openai", model: "openai/gpt-5.6-sol", reasoning: "medium",
        providerServiceTiers: ["priority"], requestServiceTiers: ["default"], requestModels: ["openai/gpt-5.6-sol"],
        requestReasoning: ["medium"], authorizationSchemes: ["bearer"], routeIds: ["openai-responses"] } }, {
      pairedAuthReceipt: { schema: "butler.provider-auth-preflight-receipt.v1", authority: "butler_auth_status_and_model_catalog",
        provider: "openai", authMode: "managed", observedProductAuthMode: "codex_oauth", observedProductAuthSource: "CODEX_AUTH_JSON", model: "openai/gpt-5.6-sol",
        reasoning: "medium", executionMode: "ordinary_non_fast", modelCallability: "available", configured: true },
    });
    expect(executionRejected.m1V2?.status).toBe("accepted");
    expect(executionRejected.terminalState).toBe("rejected");

    const sourceMismatch = evaluateAdapterResult(arm, fixture, {
      ...adapterResult,
      m1V2Evidence: {
        ...adapterResult.m1V2Evidence!,
        metrics: adapterResult.m1V2Evidence!.metrics.map((event) =>
          event.name === "m1_v2_request_envelope"
            ? { ...event, dimensions: { ...event.dimensions, sourceRevision: "b".repeat(40) } }
            : event),
      },
    });
    expect(sourceMismatch.terminalState).toBe("rejected");
    expect(sourceMismatch.m1V2?.reasons).toContain("source_revision_identity_mismatch");

    const byteMismatch = evaluateAdapterResult(arm, fixture, {
      ...adapterResult,
      m1V2Evidence: {
        ...adapterResult.m1V2Evidence!,
        metrics: adapterResult.m1V2Evidence!.metrics.map((event) =>
          event.name === "m1_v2_request_segment"
            ? { ...event, dimensions: { ...event.dimensions, providerSendBytes: 99 } }
            : event),
      },
    });
    expect(byteMismatch.m1V2?.reasons).toContain("exact_byte_sum_failed");

    const hashMismatchEvidence = structuredClone(evidence);
    hashMismatchEvidence.observations[0]!.promptSha256 = "0".repeat(64);
    const hashMismatch = evaluateAdapterResult(arm, fixture, {
      ...adapterResult,
      m1V2Evidence: { ...adapterResult.m1V2Evidence!, evidence: hashMismatchEvidence },
    });
    expect(hashMismatch.m1V2?.reasons).toContain("evidence_prompt_hash_mismatch");

    const staleEvidence = structuredClone(evidence);
    staleEvidence.generatedAt = "2026-08-11T23:59:00.000Z";
    const stale = evaluateAdapterResult(arm, fixture, {
      ...adapterResult,
      m1V2Evidence: { ...adapterResult.m1V2Evidence!, evidence: staleEvidence },
    });
    expect(stale.m1V2?.reasons).toContain("stale_evidence_mismatch");

    const summary = summarizeBenchmarkResult({
      schema: "butler.agent-benchmark.v1",
      kind: "agent_benchmark_result",
      run: { runId: plan.runId, seed: plan.seed, baselineSha: plan.baselineSha, runRoot: plan.runRoot, state: "reported" },
      plan,
      observations: [sourceMismatch],
    });
    expect(summary.m1V2Campaign).toMatchObject({
      schema: "butler.agent-benchmark.m1-v2.v1",
      complete: false,
      counts: { accepted: 0, rejected: 1, gated: 0 },
      privacy: { rawPromptStored: false, rawFinalStored: false, privatePathStored: false },
    });
  });
});
