import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupButlerRuntime } from "../support/agent-benchmark/butler-runtime-cleanup.ts";
import { createButlerAdapter } from "../support/agent-benchmark/butler-adapter.ts";
import { replacementEligibility } from "../support/agent-benchmark/paired-contract.ts";
import { exportedM1V2Metrics, materializeM1V2EvidenceExport, verifyM1V2EvidenceExport } from "../support/agent-benchmark/m1-v2-evidence-export.ts";

test("durable SC01 projection survives cleanup and preserves exact nullable attempt rows", () => {
  const fixture = exportFixture();
  const result = materializeM1V2EvidenceExport(fixture.input);
  expect(result.evidence.attempts[0]!.serializedRequestBytes).toBe(100);
  expect(result.evidence.attempts[0]!.segments.reduce((sum, row) => sum + Number(row.providerSendBytes), 0)).toBe(100);
  expect(result.evidence.attempts[0]!.usage.promptTokens).toBeNull();
  expect(result.evidence.overhead.map((row) => row.role)).toEqual(["title"]);
  expect(JSON.stringify(result.evidence)).not.toContain(fixture.root);
  expect(exportedM1V2Metrics(result.evidence).filter((row) => row.name === "m1_v2_request_segment")
    .reduce((sum, row) => sum + Number(row.dimensions?.providerSendBytes), 0)).toBe(100);

  const resumed = materializeM1V2EvidenceExport(fixture.input);
  expect(resumed.sha256).toBe(result.sha256);
  const cleanup = cleanupButlerRuntime(fixture.evidence, fixture.arm, true);
  expect(cleanup.status).toBe("removed");
  expect(existsSync(fixture.dataRoot)).toBe(false);
  expect(verifyM1V2EvidenceExport({ path: result.absolutePath, expected: fixture.input.identity }).sha256).toBe(result.sha256);
});

test("SC01 export fails closed on privacy extras, temp/conflict/mutation, and blocks cleanup", () => {
  const unsafe = exportFixture();
  unsafe.input.metrics[0]!.dimensions!.prompt = "raw";
  expect(() => materializeM1V2EvidenceExport(unsafe.input)).toThrow("allowlist");
  expect(cleanupButlerRuntime(unsafe.evidence, unsafe.arm, false).status).toBe("failed");
  expect(existsSync(unsafe.dataRoot)).toBe(true);

  const rawBody = exportFixture();
  (rawBody.input.providerRequests[0] as Record<string, unknown>).responseBody = "secret";
  expect(() => materializeM1V2EvidenceExport(rawBody.input)).toThrow("allowlist");

  for (const [key, value] of [["toolArgs", "{}"], ["toolResult", "raw"], ["content", "raw"], ["authorization", "Bearer token"], ["hiddenReasoning", "private"]]) {
    const malicious = exportFixture();
    (malicious.input.providerRequests[0] as Record<string, unknown>)[key] = value;
    expect(() => materializeM1V2EvidenceExport(malicious.input)).toThrow("allowlist");
  }
  for (const privatePath of ["/private/path", "/var/folders/secret", "/Users/private/path"]) {
    const malicious = exportFixture(); malicious.input.identity.sessionId = privatePath;
    expect(() => materializeM1V2EvidenceExport(malicious.input)).toThrow("identity");
  }
  const credentialModel = exportFixture(); credentialModel.input.identity.expectedModelRef = "sk-proj-secret";
  expect(() => materializeM1V2EvidenceExport(credentialModel.input)).toThrow("identity_invalid");
  for (const [metricIndex, key, value] of [
    [0, "modelRef", "raw transcript"],
    [1, "keyedContentDigest", "raw"],
    [1, "segmentId", "raw transcript"],
    [3, "promptTokens", "raw private data"],
    [3, "totalTokens", -1],
  ] as const) {
    const malicious = exportFixture(); malicious.input.metrics[metricIndex]!.dimensions![key] = value;
    expect(() => materializeM1V2EvidenceExport(malicious.input)).toThrow();
  }
  const duplicateSegment = exportFixture();
  duplicateSegment.input.metrics[2]!.dimensions!.segmentId = duplicateSegment.input.metrics[1]!.dimensions!.segmentId!;
  expect(() => materializeM1V2EvidenceExport(duplicateSegment.input)).toThrow("segment_value_invalid");

  const partial = exportFixture();
  writeFileSync(join(partial.arm.evidenceRoot, "sc01-public-evidence.json.tmp"), "partial");
  expect(() => materializeM1V2EvidenceExport(partial.input)).toThrow("temporary");

  const ambiguous = exportFixture();
  ambiguous.input.providerRequests.push({ ...ambiguous.input.providerRequests[1]! });
  expect(() => materializeM1V2EvidenceExport(ambiguous.input)).toThrow("ordinal_ambiguous");

  const mutated = exportFixture();
  const output = materializeM1V2EvidenceExport(mutated.input);
  writeFileSync(output.absolutePath, readFileSync(output.absolutePath, "utf8").replace("100", "101"));
  expect(() => verifyM1V2EvidenceExport({ path: output.absolutePath, expected: mutated.input.identity })).toThrow();
  expect(() => materializeM1V2EvidenceExport(mutated.input)).toThrow("immutable");

});

test("SC01 reopen rejects a malicious typed value even with a recomputed content hash", () => {
  const forged = exportFixture(); const forgedOutput = materializeM1V2EvidenceExport(forged.input);
  const forgedValue = JSON.parse(readFileSync(forgedOutput.absolutePath, "utf8")) as Record<string, unknown> & { attempts: Array<{ usage: Record<string, unknown> }>; contentSha256: string };
  forgedValue.attempts[0]!.usage.promptTokens = "raw private data";
  forgedValue.contentSha256 = createHash("sha256").update(JSON.stringify({ ...forgedValue, contentSha256: "" })).digest("hex");
  writeFileSync(forgedOutput.absolutePath, `${JSON.stringify(forgedValue, null, 2)}\n`);
  expect(() => verifyM1V2EvidenceExport({ path: forgedOutput.absolutePath, expected: forged.input.identity })).toThrow("usage_value_invalid");
});

test("SC01 rejects unavailable usage tokens and provider identity drift before cleanup", () => {
  const usage = exportFixture(); usage.input.metrics[3]!.dimensions!.promptTokens = 7;
  expect(() => materializeM1V2EvidenceExport(usage.input)).toThrow("usage_value_invalid");
  for (const [key, value] of [["requestedReasoning", "high"], ["authorizationScheme", "basic"], ["requestedModel", "other-model"], ["providerReportedModel", "other-model"]] as const) {
    const drift = exportFixture(); drift.input.providerRequests[0]![key] = value;
    expect(() => materializeM1V2EvidenceExport(drift.input)).toThrow();
    expect(existsSync(drift.dataRoot)).toBe(true);
  }
});

test("unknown effective tier remains durable but reconstructs a rejected target attempt", () => {
  const fixture = exportFixture(); const request = fixture.input.providerRequests[0]! as Record<string, unknown>;
  request.providerReportedServiceTier = null;
  request.effectiveServiceTierAvailability = "unavailable";
  request.effectiveServiceTierReason = "provider_response_omitted";
  const exported = materializeM1V2EvidenceExport(fixture.input).evidence;
  expect(exported.attempts[0]).toMatchObject({ effectiveServiceTier: null, effectiveServiceTierAvailability: "unavailable" });
  expect(exportedM1V2Metrics(exported).find((row) => row.name === "m1_v2_request_envelope")?.dimensions?.eligibility).toBe("rejected");
});

test("SC01 export keeps retries and typed overhead ownership separate with nullable usage", () => {
  const fixture = exportFixture(); const secondDigest = "B".repeat(43);
  const firstRequest = fixture.input.providerRequests[0]!;
  fixture.input.providerRequests.push({ ...firstRequest, ordinal: 3, attemptDigest: secondDigest, requestStartedAtMs: 210, completedAtMs: 300, terminatedAtMs: 300 });
  fixture.input.providerRequests.push({ ...firstRequest, ordinal: 4, attemptDigest: null, requestKind: "auxiliary", serializedRequestBytes: 20, requestStartedAtMs: 310, completedAtMs: 320, terminatedAtMs: 320 });
  fixture.input.providerRequests.push({ ...firstRequest, ordinal: 5, attemptDigest: null, requestKind: "tool_provider", serializedRequestBytes: 30, requestStartedAtMs: 330, completedAtMs: 350, terminatedAtMs: 350 });
  const memberships = fixture.input.target.providerRequestIdentities as Record<string, unknown>[];
  memberships.push({ ordinal: 3, sessionId: fixture.input.identity.sessionId, turnId: fixture.input.identity.turnId, requestKind: "agent", attemptDigest: secondDigest });
  memberships.push({ ordinal: 4, sessionId: fixture.input.identity.sessionId, turnId: fixture.input.identity.turnId, requestKind: "auxiliary", attemptDigest: null });
  const source = fixture.input.metrics.slice(0, 4);
  fixture.input.metrics.push(...source.map((row) => ({ ...row, ts: 300, dimensions: { ...row.dimensions, attemptDigest: secondDigest,
    ...(row.name === "m1_v2_request_envelope" ? { retryOrdinal: 1, eligibility: "retry_contaminated" } : {}) } })));
  const exported = materializeM1V2EvidenceExport(fixture.input).evidence;
  expect(exported.attempts).toHaveLength(2);
  expect(exported.attempts[1]!.usage.promptTokens).toBeNull();
  expect(exported.overhead.map((row) => [row.role, row.ownership])).toEqual([
    ["title", "target_step"], ["auxiliary", "target_step"], ["tool_provider", "unarmed_physical_overhead"],
  ]);
});

test("failed physical attempt without canonical usage stays explicit unavailable before successful retry", () => {
  const fixture = exportFixture(); const retryDigest = "R".repeat(43);
  fixture.input.metrics[0]!.dimensions!.eligibility = "rejected";
  fixture.input.metrics.splice(3, 1);
  fixture.input.providerRequests[0]!.termination = "failed"; fixture.input.providerRequests[0]!.status = 500;
  fixture.input.providerRequests.push({ ...fixture.input.providerRequests[0]!, ordinal: 3, attemptDigest: retryDigest, termination: "completed", status: 200 });
  (fixture.input.target.providerRequestIdentities as Record<string, unknown>[]).push({ ordinal: 3, sessionId: fixture.input.identity.sessionId,
    turnId: fixture.input.identity.turnId, requestKind: "agent", attemptDigest: retryDigest });
  fixture.input.metrics.push(...exportFixture().input.metrics.map((row) => ({ ...row, dimensions: { ...row.dimensions, attemptDigest: retryDigest,
    ...(row.name === "m1_v2_request_envelope" ? { retryOrdinal: 1 } : {}) } })));
  const exported = materializeM1V2EvidenceExport(fixture.input).evidence;
  expect(exported.attempts[0]!.usage).toMatchObject({ status: "unavailable", promptTokens: null, availabilityReason: "provider_usage_row_absent" });
  expect(exported.counts).toMatchObject({ canonicalUsageRows: 1, projectedUsage: 2 });
});

test("direct-warm export selects target membership before same-arm warmup metrics", () => {
  const fixture = exportFixture(); const warmupDigest = "W".repeat(43);
  (fixture.input.identity as { armId: "direct-cold" | "direct-warm" }).armId = "direct-warm"; fixture.input.identity.armKey = "direct-warm:before";
  fixture.input.metrics[0]!.dimensions!.armId = "direct-warm";
  const targetRows = fixture.input.metrics.slice(0, 4);
  fixture.input.providerRequests.unshift({ ...fixture.input.providerRequests[0]!, ordinal: 3, attemptDigest: warmupDigest,
    requestStartedAtMs: 50, completedAtMs: 90, terminatedAtMs: 90 });
  fixture.input.observations.unshift({ stepId: "warmup", sessionId: "session-warmup", turnId: "turn-warmup", providerRequestIdentities: [
    { ordinal: 3, sessionId: "session-warmup", turnId: "turn-warmup", requestKind: "agent", attemptDigest: warmupDigest },
  ] });
  fixture.input.metrics.unshift(...targetRows.map((row) => ({ ...row, ts: 90, dimensions: { ...row.dimensions, attemptDigest: warmupDigest,
    ...(row.name === "m1_v2_request_envelope" ? { armId: "direct-warm", roundIndex: 0 } : {}) } })));
  const exported = materializeM1V2EvidenceExport(fixture.input).evidence;
  expect(exported.attempts.map((row) => [row.attemptDigest, row.ownership, row.stepId])).toEqual([
    [warmupDigest, "other_step", "warmup"], ["A".repeat(43), "target_step", "target"],
  ]);
  expect(exported.overhead.map((row) => row.role)).toEqual(["title"]);
  expect(exportedM1V2Metrics(exported).filter((row) => row.name === "m1_v2_request_envelope")).toHaveLength(1);
});

test("other-step membership must match its owning observation Session and Turn", () => {
  const fixture = exportFixture(); const digest = "W".repeat(43);
  fixture.input.observations.unshift({ stepId: "warmup", sessionId: "session-warmup", turnId: "turn-warmup", providerRequestIdentities: [
    { ordinal: 3, sessionId: "session-safe", turnId: "turn-warmup", requestKind: "agent", attemptDigest: digest },
  ] });
  expect(() => materializeM1V2EvidenceExport(fixture.input)).toThrow("membership_owner_identity_mismatch");
});

test("SC01 rejects missing and unknown same-arm Agent ownership", () => {
  const missing = exportFixture(); missing.input.observations.push({ stepId: "warmup", sessionId: "session-warmup", turnId: "turn-warmup", providerRequestIdentities: [
    { ordinal: 3, sessionId: "session-warmup", turnId: "turn-warmup", requestKind: "agent", attemptDigest: "W".repeat(43) },
  ] });
  missing.input.providerRequests.push({ ...missing.input.providerRequests[0]!, ordinal: 3, attemptDigest: "W".repeat(43) });
  expect(() => materializeM1V2EvidenceExport(missing.input)).toThrow("membership_incomplete");
  const extra = exportFixture(); extra.input.metrics.unshift(...extra.input.metrics.slice(0, 4).map((row) => ({ ...row, dimensions: { ...row.dimensions, attemptDigest: "X".repeat(43) } })));
  expect(() => materializeM1V2EvidenceExport(extra.input)).toThrow("physical_attempt_join_failed");
  const orphanRequest = exportFixture(); orphanRequest.input.providerRequests.push({ ...orphanRequest.input.providerRequests[0]!, ordinal: 4, attemptDigest: null });
  expect(() => materializeM1V2EvidenceExport(orphanRequest.input)).toThrow("membership_incomplete");
  const missingOverhead = exportFixture(); missingOverhead.input.providerRequests.splice(1, 1);
  expect(() => materializeM1V2EvidenceExport(missingOverhead.input)).toThrow("non_agent_membership_incomplete");
});

test("SC01 publication rejects a symlinked evidence root", () => {
  const fixture = exportFixture(); const external = mkdtempSync(join(tmpdir(), "sc01-external-")); const link = join(fixture.input.runRoot, "linked-evidence");
  symlinkSync(external, link); fixture.input.evidenceRoot = link;
  expect(() => materializeM1V2EvidenceExport(fixture.input)).toThrow("symlink_rejected");
});

test("real Butler adapter blocks failed export, preserves dataRoot, and forbids post-dispatch replacement", async () => {
  const fixture = exportFixture(); const identity = fixture.input.identity;
  const arm = { key: identity.armKey, scenario: identity.armId, repetition: 1, order: 0, agent: "butler" as const, track: "controlled" as const,
    cache: "cold" as const, fixtureHash: identity.fixtureHash, effectiveConfig: { model: "openai/gpt-5.6-sol", reasoning: "medium", permissions: "full_access", tools: [], memoryEnabled: true, skillsEnabled: true, pluginsEnabled: true, mcpEnabled: true, provider: "openai", variant: null },
    sourceRoot: fixture.arm.sourceRoot, outputRoot: fixture.arm.outputRoot, dataRoot: fixture.arm.dataRoot, evidenceRoot: fixture.arm.evidenceRoot,
    cacheRoot: fixture.arm.cacheRoot, cachePairId: "pair", timeoutMs: 1_000, sourceRevision: identity.sourceRevision };
  const benchmarkFixture = { id: "direct-cold" as const, version: "v1", prompts: ["safe"], m1V2: { armId: "direct-cold" as const,
    scenario: { schema: "butler.btcc-r3-electron-scenario.v1" as const, id: "safe", attributionArmId: "direct-cold" as const, model: "openai/gpt-5.6-sol", reasoningEffort: "medium" as const, accessMode: "full_access" as const, session: { id: identity.sessionId, kind: "chat" as const, title: "safe" }, fixtures: [], steps: [], publicBenchmarkFixture: true },
    targetStepId: identity.stepId, publicBenchmarkFixture: true as const, promptSha256: { [identity.stepId]: "a".repeat(64) }, fixtureSha256: { [identity.stepId]: identity.fixtureHash } } };
  const evidence = { ok: true, generatedAt: new Date().toISOString(), run: { dataRoot: fixture.dataRoot, runRoot: fixture.arm.evidenceRoot,
    workspaceRoot: join(fixture.arm.evidenceRoot, "workspace"), model: "openai/gpt-5.6-sol", reasoningEffort: "medium" }, session: { id: identity.sessionId },
    isolation: { bindingWorkspace: join(fixture.arm.evidenceRoot, "workspace"), workspaceInsideRunRoot: true, sourceDataIsRunData: false },
    observations: [{ ...fixture.input.target, terminalState: "delivered", finalText: "안녕하세요.", providerReportedModel: "gpt-5.6-sol",
      providerAgentModels: ["gpt-5.6-sol"], timing: { submittedAtMs: Date.now() - 10, terminalAtMs: Date.now(), elapsedMs: 10 }, reload: { tested: true, finalMatched: true }, promptSha256: "a".repeat(64) }], providerRequests: fixture.input.providerRequests };
  const adapter = createButlerAdapter(async () => evidence, fixture.arm.sourceRoot);
  const result = await adapter.run({ arm, fixture: benchmarkFixture, prompt: "safe", sessionId: null, sourceEvidenceRoot: "", runtimeInstructions: "safe",
    signal: new AbortController().signal, benchmarkEvidence: { planIdentity: identity.planIdentity, runRoot: fixture.input.runRoot } });
  expect(result.gateCode).toBe("measurement_unavailable");
  expect(result).toMatchObject({ exitCode: 0, finalText: "안녕하세요.", providerDispatchState: "provider_output_observed" });
  expect(result.evidenceRefs).toEqual([]);
  expect(existsSync(fixture.dataRoot)).toBe(true);
  expect(replacementEligibility({ providerDispatchState: "provider_dispatched", infrastructureGateStage: null }).allowed).toBe(false);
});

function exportFixture() {
  const root = mkdtempSync(join(tmpdir(), "sc01-export-"));
  const runRoot = join(root, "run"); const evidenceRoot = join(runRoot, "arms/block-1/before/evidence");
  const dataRoot = join(evidenceRoot, "data"); mkdirSync(dataRoot, { recursive: true });
  const digest = "A".repeat(43); const sessionId = "session-safe"; const turnId = "turn-safe";
  const provider = (ordinal: number, role: "agent" | "title" | "auxiliary" | "tool_provider", bytes: number, attemptDigest: string | null) => ({
    ordinal, attemptDigest, requestKind: role, requestedModel: "gpt-5.6-sol", requestedReasoning: "medium", requestedServiceTier: null, requestedServiceTierMode: "auto_by_omission",
    authorizationScheme: "bearer", routeId: "openai-codex-responses", requestStartedAtMs: 100 + ordinal,
    serializedRequestBytes: bytes, serializedRequestDigest: createHash("sha256").update(String(ordinal)).digest("hex"), serializedRequestDigestAlgorithm: "hmac-sha256-observer-private-v1",
    serializerContract: "butler.openai-codex-final-json.v1", firstContentBearingDeltaAtMs: role === "agent" ? 10 : null,
    completedAtMs: 200 + ordinal, terminatedAtMs: 200 + ordinal, termination: "completed", status: 200,
    hasTextContent: true, hasToolArgumentContent: false, hasReasoningContent: false, streamedTextChars: 1, finalTextChars: 0,
    providerReportedModel: "gpt-5.6-sol", providerReportedServiceTier: "default", effectiveServiceTierAvailability: "reported", effectiveServiceTierReason: "provider_response_reported",
  });
  const metric = (name: string, dimensions: Record<string, string | number | boolean | null>) => ({ schema: "butler.operational-metric.v1" as const,
    ts: 200, category: "context" as const, name, status: "ok" as const, dimensions, rawTextStored: false as const });
  const metrics = [
    metric("m1_v2_request_envelope", { schemaVersion: "butler.m1-request-envelope.v2", attemptDigest: digest, turnDigest: "T".repeat(43), phaseDigest: "P".repeat(43),
      roundIndex: 0, retryOrdinal: 0, providerId: "openai-codex", modelRef: "openai/gpt-5.6-sol", armId: "direct-cold", sourceRevision: "c".repeat(40),
      cacheBoundaryRevision: "current", providerSendBytes: 100, estimatedInputTokens: null, eligibility: "usage_unavailable" }),
    metric("m1_v2_request_segment", { schemaVersion: "butler.m1-request-segment.v2", attemptDigest: digest, segmentId: "segment-01",
      kind: "provider_carrier_overhead", stability: "dynamic", providerSendBytes: 40, estimatedInputTokens: null, keyedContentDigest: "K".repeat(43) }),
    metric("m1_v2_request_segment", { schemaVersion: "butler.m1-request-segment.v2", attemptDigest: digest, segmentId: "segment-02",
      kind: "current_user_request", stability: "dynamic", providerSendBytes: 60, estimatedInputTokens: null, keyedContentDigest: "L".repeat(43) }),
    metric("m1_v2_response_usage", { schemaVersion: "butler.m1-response-usage.v2", attemptDigest: digest, status: "unavailable", promptTokens: null,
      cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null }),
  ];
  const target = { stepId: "target", sessionId, turnId, providerRequestIdentities: [
    { ordinal: 1, sessionId, turnId, requestKind: "agent", attemptDigest: digest },
    { ordinal: 2, sessionId, turnId, requestKind: "title", attemptDigest: null },
  ] };
  const evidence = { run: { dataRoot } };
  const arm = { evidenceRoot, outputRoot: join(runRoot, "output"), cacheRoot: join(runRoot, "cache"), dataRoot: join(runRoot, "declared-data"), sourceRoot: join(root, "source") };
  return { root, dataRoot, evidence, arm, input: { runRoot, evidenceRoot, identity: { planIdentity: "a".repeat(64), sourceRevision: "c".repeat(40), fixtureHash: "f".repeat(64),
    armKey: "direct-cold:before", armId: "direct-cold" as const, repetition: 1, block: 1, stepId: "target",
    version: "before" as const, pairId: "pair-1", armOrder: 0, sessionId, turnId, expectedProviderId: "openai-codex" as const,
    expectedModelRef: "openai/gpt-5.6-sol", expectedRouteId: "openai-codex-responses" as const, expectedCacheBoundaryRevision: "current" },
    target, observations: [target], providerRequests: [provider(1, "agent", 100, digest), provider(2, "title", 20, null)], metrics } };
}
