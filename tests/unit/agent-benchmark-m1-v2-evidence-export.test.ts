import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupButlerRuntime } from "../support/agent-benchmark/butler-runtime-cleanup.ts";
import { createButlerAdapter } from "../support/agent-benchmark/butler-adapter.ts";
import { replacementEligibility } from "../support/agent-benchmark/paired-contract.ts";
import { redactBenchmarkPlan } from "../support/agent-benchmark/checkpoint.ts";
import { benchmarkPlanIdentity } from "../support/agent-benchmark/planning.ts";
import { evaluateM1V2AdapterEvidence } from "../support/agent-benchmark/m1-v2-adapter-evaluation.ts";
import failedAttemptManifest from "../support/agent-benchmark/fixtures/m1-v2/failed-attempt-03-redacted-manifest.json";
import failedAttemptIdentities from "../support/agent-benchmark/fixtures/m1-v2/failed-attempt-03-identities.json";
import { durableM1V2Arithmetic, exportedM1V2Metrics, materializeM1V2EvidenceExport, verifyM1V2EvidenceExport } from "../support/agent-benchmark/m1-v2-evidence-export.ts";

test("durable SC01 projection survives cleanup and preserves exact nullable attempt rows", () => {
  const fixture = exportFixture();
  const result = materializeM1V2EvidenceExport(fixture.input);
  expect(result.evidence.attempts[0]!.serializedRequestBytes).toBe(100);
  expect(result.evidence.attempts[0]!.segments.reduce((sum, row) => sum + Number(row.providerSendBytes), 0)).toBe(100);
  expect(result.evidence.attempts[0]!.usage.promptTokens).toBeNull();
  expect(result.evidence.overhead.map((row) => row.role)).toEqual(["title"]);
  expect(result.evidence.overhead[0]!.attemptDigest).toBe("B".repeat(43));
  expect(JSON.stringify(result.evidence)).not.toContain(fixture.root);
  expect(exportedM1V2Metrics(result.evidence).filter((row) => row.name === "m1_v2_request_segment")
    .reduce((sum, row) => sum + Number(row.dimensions?.providerSendBytes), 0)).toBe(100);

  const resumed = materializeM1V2EvidenceExport(fixture.input);
  expect(resumed.sha256).toBe(result.sha256);
  const cleanup = cleanupButlerRuntime(fixture.evidence, fixture.arm, "verified");
  expect(cleanup.status).toBe("removed");
  expect(existsSync(fixture.dataRoot)).toBe(false);
  expect(verifyM1V2EvidenceExport({ path: result.absolutePath, expected: result.evidence.identity }).sha256).toBe(result.sha256);
});

test("SC01 export fails closed on privacy extras, temp/conflict/mutation, and blocks cleanup", () => {
  const unsafe = exportFixture();
  unsafe.input.metrics[0]!.dimensions!.prompt = "raw";
  expect(() => materializeM1V2EvidenceExport(unsafe.input)).toThrow("allowlist");
  expect(cleanupButlerRuntime(unsafe.evidence, unsafe.arm, "missing_or_failed").status).toBe("failed");
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
  expect(() => verifyM1V2EvidenceExport({ path: output.absolutePath, expected: output.evidence.identity })).toThrow();
  expect(() => materializeM1V2EvidenceExport(mutated.input)).toThrow("immutable");

});

test("SC01 reopen rejects a malicious typed value even with a recomputed content hash", () => {
  const forged = exportFixture(); const forgedOutput = materializeM1V2EvidenceExport(forged.input);
  const forgedValue = JSON.parse(readFileSync(forgedOutput.absolutePath, "utf8")) as Record<string, unknown> & { attempts: Array<{ usage: Record<string, unknown> }>; contentSha256: string };
  forgedValue.attempts[0]!.usage.promptTokens = "raw private data";
  forgedValue.contentSha256 = createHash("sha256").update(JSON.stringify({ ...forgedValue, contentSha256: "" })).digest("hex");
  writeFileSync(forgedOutput.absolutePath, `${JSON.stringify(forgedValue, null, 2)}\n`);
  expect(() => verifyM1V2EvidenceExport({ path: forgedOutput.absolutePath, expected: forgedOutput.evidence.identity })).toThrow("usage_value_invalid");
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

test("non-Agent effective tier is preserved for default, nondefault, and unknown responses", () => {
  const cases = [
    ["default", "reported", "provider_response_reported"],
    ["flex", "reported", "provider_response_reported"],
    [null, "unavailable", "provider_response_omitted"],
  ] as const;
  for (const [tier, availability, reason] of cases) {
    const fixture = exportFixture(); const request = fixture.input.providerRequests[1]!;
    Object.assign(request, { providerReportedServiceTier: tier });
    request.effectiveServiceTierAvailability = availability;
    request.effectiveServiceTierReason = reason;
    expect(materializeM1V2EvidenceExport(fixture.input).evidence.overhead[0]).toMatchObject({
      requestedServiceTierMode: "auto_by_omission", effectiveServiceTier: tier,
      effectiveServiceTierAvailability: availability, effectiveServiceTierReason: reason,
    });
  }
});

test("SC01 export keeps retries and typed overhead ownership separate with nullable usage", () => {
  const fixture = exportFixture(); const secondDigest = "E".repeat(43);
  const firstRequest = fixture.input.providerRequests[0]!;
  fixture.input.providerRequests.push({ ...firstRequest, ordinal: 3, attemptDigest: secondDigest, requestStartedAtMs: 210, completedAtMs: 300, terminatedAtMs: 300 });
  fixture.input.providerRequests.push({ ...firstRequest, ordinal: 4, attemptDigest: "C".repeat(43), requestKind: "auxiliary", serializedRequestBytes: 20, requestStartedAtMs: 310, completedAtMs: 320, terminatedAtMs: 320 });
  fixture.input.providerRequests.push({ ...firstRequest, ordinal: 5, attemptDigest: "D".repeat(43), requestKind: "tool_provider", serializedRequestBytes: 30, requestStartedAtMs: 330, completedAtMs: 350, terminatedAtMs: 350 });
  const memberships = fixture.input.target.providerRequestIdentities as Record<string, unknown>[];
  memberships.push({ ordinal: 3, sessionId: fixture.input.identity.sessionId, turnId: fixture.input.identity.turnId, requestKind: "agent", physicalAttemptDigest: secondDigest });
  memberships.push({ ordinal: 4, sessionId: fixture.input.identity.sessionId, turnId: fixture.input.identity.turnId, requestKind: "auxiliary", physicalAttemptDigest: "C".repeat(43) });
  const source = fixture.input.metrics.slice(0, 4);
  fixture.input.metrics.push(...source.map((row) => ({ ...row, ts: 300, dimensions: { ...row.dimensions, attemptDigest: secondDigest,
    ...(row.name === "m1_v2_request_envelope" ? { retryOrdinal: 1, eligibility: "retry_contaminated" } : {}) } })));
  const exported = materializeM1V2EvidenceExport(fixture.input).evidence;
  expect(exported.attempts).toHaveLength(2);
  expect(exported.attempts[1]!.usage.promptTokens).toBeNull();
  expect(exported.overhead.map((row) => [row.role, row.ownership])).toEqual([
    ["title", "target_step"], ["auxiliary", "target_step"], ["tool_provider", "unarmed_physical_overhead"],
  ]);
  expect(exported.overhead.map((row) => row.attemptDigest)).toEqual([
    "B".repeat(43), "C".repeat(43), "D".repeat(43),
  ]);
});

test("non-Agent physical digests are exact identities without SC01 segments", () => {
  const fixture = exportFixture();
  fixture.input.providerRequests.push({
    ...fixture.input.providerRequests[0]!, ordinal: 3, requestKind: "auxiliary",
    attemptDigest: "C".repeat(43), serializedRequestBytes: 30,
    requestStartedAtMs: 210, completedAtMs: 230, terminatedAtMs: 230,
  });
  (fixture.input.target.providerRequestIdentities as Record<string, unknown>[]).push({
    ordinal: 3, sessionId: fixture.input.identity.sessionId,
    turnId: fixture.input.identity.turnId, requestKind: "auxiliary",
    physicalAttemptDigest: "C".repeat(43),
  });
  const exported = materializeM1V2EvidenceExport(fixture.input).evidence;
  expect(exported.attempts.map((row) => row.serializedRequestBytes)).toEqual([100]);
  expect(exported.overhead.map((row) => [row.role, row.attemptDigest, row.providerSendBytes])).toEqual([
    ["title", "B".repeat(43), 20],
    ["auxiliary", "C".repeat(43), 30],
  ]);
  expect(exported.counts).toMatchObject({ attempts: 1, overhead: 2, segments: 2 });
});

test("role-aware SC01 preserves exact 591-byte title and auxiliary telemetry outside Agent arithmetic", () => {
  const fixture = exportFixture();
  fixture.input.providerRequests[1]!.serializedRequestBytes = 591;
  const auxiliaryDigest = "C".repeat(43);
  fixture.input.providerRequests.push({ ...fixture.input.providerRequests[1]!, ordinal: 3, requestKind: "auxiliary",
    attemptDigest: auxiliaryDigest, serializedRequestBytes: 31, requestStartedAtMs: 210, completedAtMs: 230, terminatedAtMs: 230 });
  (fixture.input.target.providerRequestIdentities as Record<string, unknown>[]).push({ ordinal: 3,
    sessionId: fixture.input.identity.sessionId, turnId: fixture.input.identity.turnId,
    requestKind: "auxiliary", physicalAttemptDigest: auxiliaryDigest });
  const overheadRows = (attemptDigest: string, bytes: number, usageBearing: boolean) => [
    { ...fixture.input.metrics[0]!, dimensions: { ...fixture.input.metrics[0]!.dimensions!, attemptDigest, armId: null,
      providerSendBytes: bytes, retryOrdinal: 0, eligibility: usageBearing ? "eligible" : "usage_unavailable" } },
    { ...fixture.input.metrics[1]!, dimensions: { ...fixture.input.metrics[1]!.dimensions!, attemptDigest,
      segmentId: `${attemptDigest[0]}-carrier`, providerSendBytes: Math.floor(bytes / 2) } },
    { ...fixture.input.metrics[2]!, dimensions: { ...fixture.input.metrics[2]!.dimensions!, attemptDigest,
      segmentId: `${attemptDigest[0]}-request`, providerSendBytes: bytes - Math.floor(bytes / 2) } },
    { ...fixture.input.metrics[3]!, dimensions: { ...fixture.input.metrics[3]!.dimensions!, attemptDigest,
      ...(usageBearing ? { status: "usage_bearing", promptTokens: 7, outputTokens: 3, totalTokens: 10 } : {}) } },
  ];
  fixture.input.metrics.push(...overheadRows("B".repeat(43), 591, true), ...overheadRows(auxiliaryDigest, 31, false));
  const exported = materializeM1V2EvidenceExport(fixture.input).evidence;
  const arithmetic = durableM1V2Arithmetic(exported);
  expect(arithmetic.agentAttempts.map((row) => row.providerSendBytes)).toEqual([100]);
  expect(arithmetic.unarmedPhysicalOverhead.title).toEqual({ attempts: 1, providerSendBytes: 591 });
  expect(arithmetic.unarmedPhysicalOverhead.auxiliary).toEqual({ attempts: 1, providerSendBytes: 31 });
  expect(arithmetic.overheadUsage).toMatchObject({
    title: { observed: 1, usageBearing: 1, unavailable: 0 },
    auxiliary: { observed: 1, usageBearing: 0, unavailable: 1 },
  });
  expect(arithmetic.allPhysical).toEqual({ attempts: 3, providerSendBytes: 722, observedUsageRows: 3, usageBearingRows: 1, unavailableUsageRows: 2 });
  expect(exported.overhead[0]!.observation!.segments.reduce((sum, row) => sum + Number(row.providerSendBytes), 0)).toBe(591);
});

test("public title projection preserves absent canonical provider usage as typed unavailable", () => {
  const fixture = exportFixture();
  fixture.input.providerRequests[0]!.serializedRequestBytes = 37_673;
  fixture.input.metrics[0]!.dimensions!.providerSendBytes = 37_673;
  fixture.input.metrics.splice(1, 2, ...Array.from({ length: 8 }, (_, index) => ({
    ...fixture.input.metrics[1]!, dimensions: { ...fixture.input.metrics[1]!.dimensions!, segmentId: `agent-${index}`,
      providerSendBytes: index === 7 ? 4_717 : 4_708 },
  })));
  const agentUsage = fixture.input.metrics.find((row) => row.name === "m1_v2_response_usage")!;
  Object.assign(agentUsage.dimensions!, { status: "usage_bearing", promptTokens: 7_216, cacheReadTokens: 0,
    cacheWriteTokens: 0, outputTokens: null, reasoningTokens: null, totalTokens: 7_241 });
  fixture.input.providerRequests[1]!.serializedRequestBytes = 591;
  const overheadRows = (attemptDigest: string, bytes: number, segments: number) => [
    { ...fixture.input.metrics[0]!, dimensions: { ...fixture.input.metrics[0]!.dimensions!, attemptDigest, armId: null, providerSendBytes: bytes } },
    ...Array.from({ length: segments }, (_, index) => ({ ...fixture.input.metrics[1]!, dimensions: {
      ...fixture.input.metrics[1]!.dimensions!, attemptDigest, segmentId: `${attemptDigest[0]}-${index}`,
      providerSendBytes: index === segments - 1 ? bytes - Math.floor(bytes / segments) * (segments - 1) : Math.floor(bytes / segments),
    } })),
  ];
  fixture.input.metrics.push(...overheadRows("B".repeat(43), 591, 3));
  const auxiliaryDigest = "C".repeat(43);
  fixture.input.providerRequests.push({ ...fixture.input.providerRequests[1]!, ordinal: 3, requestKind: "auxiliary",
    attemptDigest: auxiliaryDigest, serializedRequestBytes: 981, requestStartedAtMs: 210, completedAtMs: 230, terminatedAtMs: 230 });
  (fixture.input.target.providerRequestIdentities as Record<string, unknown>[]).push({ ordinal: 3,
    sessionId: fixture.input.identity.sessionId, turnId: fixture.input.identity.turnId,
    requestKind: "auxiliary", physicalAttemptDigest: auxiliaryDigest });
  fixture.input.metrics.push(...overheadRows(auxiliaryDigest, 981, 1));

  const output = materializeM1V2EvidenceExport(fixture.input);
  const verified = verifyM1V2EvidenceExport({ path: output.absolutePath, expected: output.evidence.identity });
  expect(verified.evidence.overhead[0]!.observation!.usage).toEqual({
    schemaVersion: "butler.m1-response-usage.v2", attemptDigest: "B".repeat(43), status: "unavailable",
    promptTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null,
    reasoningTokens: null, totalTokens: null, availabilityReason: "provider_usage_row_absent",
  });
  expect(durableM1V2Arithmetic(verified.evidence)).toMatchObject({
    agentAttempts: [{ providerSendBytes: 37_673, responseUsageStatus: "usage_bearing", promptTokens: 7_216,
      cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: null, reasoningTokens: null, totalTokens: 7_241 }],
    unarmedPhysicalOverhead: { title: { attempts: 1, providerSendBytes: 591 }, auxiliary: { attempts: 1, providerSendBytes: 981 } },
    allPhysical: { attempts: 3, providerSendBytes: 39_245, observedUsageRows: 3, usageBearingRows: 1, unavailableUsageRows: 2 },
  });
  expect(verified.evidence.attempts[0]!.segments).toHaveLength(8);
  expect(verified.evidence.overhead[0]!.observation!.segments).toHaveLength(3);

  const arm = { key: fixture.input.identity.armKey, scenario: "direct-cold" as const, repetition: 1, order: 0,
    agent: "butler" as const, track: "controlled" as const, cache: "cold" as const, fixtureHash: fixture.input.identity.fixtureHash,
    effectiveConfig: { model: "openai/gpt-5.6-sol", reasoning: "medium", permissions: "full_access", tools: [], memoryEnabled: true, skillsEnabled: true, pluginsEnabled: true, mcpEnabled: true, provider: "openai", variant: null },
    sourceRoot: fixture.arm.sourceRoot, outputRoot: fixture.arm.outputRoot, dataRoot: fixture.arm.dataRoot,
    evidenceRoot: fixture.input.evidenceRoot, cacheRoot: fixture.arm.cacheRoot, cachePairId: "pair", timeoutMs: 1_000,
    sourceRevision: fixture.input.identity.sourceRevision, version: "before" as const, pairId: "pair-1", block: 1 };
  const benchmarkFixture = { id: "direct-cold" as const, version: "v1", prompts: ["safe"], m1V2: { armId: "direct-cold" as const,
    scenario: { schema: "butler.btcc-r3-electron-scenario.v1" as const, id: "safe", attributionArmId: "direct-cold" as const,
      model: "openai/gpt-5.6-sol", reasoningEffort: "medium" as const, accessMode: "full_access" as const,
      session: { id: fixture.input.identity.sessionId, kind: "chat" as const, title: "safe" }, fixtures: [], steps: [], publicBenchmarkFixture: true },
    targetStepId: fixture.input.identity.stepId, publicBenchmarkFixture: true as const,
    promptSha256: { [fixture.input.identity.stepId]: "a".repeat(64) }, fixtureSha256: { [fixture.input.identity.stepId]: fixture.input.identity.fixtureHash } } };
  const evaluated = evaluateM1V2AdapterEvidence({ arm, fixture: benchmarkFixture, terminalState: "accepted", result: {
    exitCode: 0, gateCode: "none", timedOut: false, cancelled: false, stdout: "", stderr: "", adapterVersion: "test", provider: "openai",
    finalText: "safe", sessionId: fixture.input.identity.sessionId, usage: {}, tools: {}, timing: {}, operations: {}, changedPaths: [], evidenceRefs: [],
    m1V2Evidence: { evidence: { observations: [fixture.input.target] }, metrics: [], db: null, landingValidation: null,
      sourceRevision: fixture.input.identity.sourceRevision, attemptStartedAtMs: 0, exportPath: output.absolutePath, exportHandle: output.handle,
      exportRunRoot: fixture.input.runRoot, exportPlanIdentity: fixture.input.identity.planIdentity, exportSha256: output.sha256, exportIdentity: output.evidence.identity },
  } });
  expect(evaluated.diagnostics).not.toContain("sc01_durable_evidence_export_verification_failed");
  expect(evaluated.summary?.allPhysical).toBeDefined();
  expect(evaluated.summary?.allPhysical?.providerSendBytes).toBe(39_245);
});

test("role-aware non-Agent SC01 rejects arm tags, byte sums, and digest-role conflicts", () => {
  const armTagged = exportFixture();
  armTagged.input.metrics.push({ ...armTagged.input.metrics[0]!, dimensions: { ...armTagged.input.metrics[0]!.dimensions!, attemptDigest: "B".repeat(43) } });
  expect(() => materializeM1V2EvidenceExport(armTagged.input)).toThrow("arm_tagged_non_agent");

  const badSum = exportFixture();
  badSum.input.metrics.push(
    { ...badSum.input.metrics[0]!, dimensions: { ...badSum.input.metrics[0]!.dimensions!, attemptDigest: "B".repeat(43), armId: null, providerSendBytes: 20 } },
    { ...badSum.input.metrics[1]!, dimensions: { ...badSum.input.metrics[1]!.dimensions!, attemptDigest: "B".repeat(43), segmentId: "title-only", providerSendBytes: 19 } },
  );
  expect(() => materializeM1V2EvidenceExport(badSum.input)).toThrow("non_agent_segment_sum_mismatch");

  const roleConflict = exportFixture();
  (roleConflict.input.target.providerRequestIdentities as Record<string, unknown>[])[1]!.requestKind = "auxiliary";
  expect(() => materializeM1V2EvidenceExport(roleConflict.input)).toThrow();
});

test("overhead SC01 creation validates full typed envelope segment and usage values", () => {
  const mutations = [
    (rows: ReturnType<typeof exportFixture>["input"]["metrics"]) => { rows[0]!.dimensions!.schemaVersion = "wrong"; },
    (rows: ReturnType<typeof exportFixture>["input"]["metrics"]) => { rows[0]!.dimensions!.turnDigest = "bad"; },
    (rows: ReturnType<typeof exportFixture>["input"]["metrics"]) => { rows[0]!.dimensions!.retryOrdinal = -1; },
    (rows: ReturnType<typeof exportFixture>["input"]["metrics"]) => { rows[0]!.dimensions!.eligibility = "unknown"; },
    (rows: ReturnType<typeof exportFixture>["input"]["metrics"]) => { rows[1]!.dimensions!.schemaVersion = "wrong"; },
    (rows: ReturnType<typeof exportFixture>["input"]["metrics"]) => { rows[1]!.dimensions!.stability = "unknown"; },
    (rows: ReturnType<typeof exportFixture>["input"]["metrics"]) => { rows[1]!.dimensions!.estimatedInputTokens = -1; },
    (rows: ReturnType<typeof exportFixture>["input"]["metrics"]) => { rows[3]!.dimensions!.schemaVersion = "wrong"; },
    (rows: ReturnType<typeof exportFixture>["input"]["metrics"]) => { rows[3]!.dimensions!.promptTokens = -1; },
  ];
  for (const mutate of mutations) {
    const fixture = exportFixture();
    const rows = fixture.input.metrics.slice(0, 4).map((row) => ({ ...row, dimensions: { ...row.dimensions, attemptDigest: "B".repeat(43), ...(row.name === "m1_v2_request_envelope" ? { armId: null, providerSendBytes: 20 } : row.name === "m1_v2_request_segment" ? { providerSendBytes: 10 } : {}) } }));
    mutate(rows);
    fixture.input.metrics.push(...rows);
    expect(() => materializeM1V2EvidenceExport(fixture.input)).toThrow();
  }
});

test("durable reopen rejects fully rehashed invalid overhead typed values", () => {
  const fixture = exportFixture();
  fixture.input.metrics.push(...fixture.input.metrics.slice(0, 4).map((row) => ({ ...row, dimensions: { ...row.dimensions, attemptDigest: "B".repeat(43), ...(row.name === "m1_v2_request_envelope" ? { armId: null, providerSendBytes: 20 } : row.name === "m1_v2_request_segment" ? { providerSendBytes: 10 } : {}) } })));
  const mutations = [
    (value: any) => { value.overhead[0].observation.envelope.phaseDigest = "bad"; },
    (value: any) => { value.overhead[0].observation.segments[0].providerSendBytes = -1; value.overhead[0].observation.segments[0].byteLength = -1; },
    (value: any) => { value.overhead[0].observation.usage.availabilityReason = "wrong"; },
    (value: any) => { value.overhead[0].observation.usage.promptTokens = "7"; },
    (value: any) => { value.overhead[0].observation.usage.availabilityReason = "provider_usage_row_absent"; value.overhead[0].observation.usage.promptTokens = 7; },
  ];
  for (const mutate of mutations) {
    const copy = exportFixture();
    copy.input.metrics.push(...fixture.input.metrics.slice(4));
    const output = materializeM1V2EvidenceExport(copy.input);
    rewriteDurableEvidence(output.absolutePath, mutate);
    expect(() => verifyM1V2EvidenceExport({ path: output.absolutePath, expected: output.evidence.identity })).toThrow();
  }
});

test("fresh plan identity is one pathless value across runtime and persisted manifest shapes", () => {
  const historicalManifestIdentity = failedAttemptIdentities.manifestSemanticPlanIdentity;
  const historicalRuntimeIdentity = failedAttemptIdentities.runtimeResultPlanIdentity;
  expect(historicalManifestIdentity).not.toBe(historicalRuntimeIdentity);
  const fixture = exportFixture();
  const arm = { key: "direct-cold:before", scenario: "direct-cold" as const, repetition: 1, order: 0,
    agent: "butler" as const, track: "controlled" as const, cache: "cold" as const, fixtureHash: "f".repeat(64),
    effectiveConfig: { model: "openai/gpt-5.6-sol", reasoning: "medium", permissions: "full_access", tools: [], memoryEnabled: true, skillsEnabled: true, pluginsEnabled: true, mcpEnabled: true, provider: "openai", variant: null },
    sourceRoot: join(fixture.root, "private-source"), outputRoot: join(fixture.input.runRoot, "arms/one/output"),
    dataRoot: join(fixture.input.runRoot, "arms/one/data"), evidenceRoot: join(fixture.input.runRoot, "arms/one/evidence"),
    cacheRoot: join(fixture.input.runRoot, "cache/one"), cachePairId: "pair", timeoutMs: 1_000,
    sourceRevision: "c".repeat(40), version: "before" as const, pairId: "pair", block: 1 };
  const plan = { schema: "butler.agent-benchmark.v1" as const, kind: "agent_benchmark_plan" as const,
    campaign: "m1-v2-paired" as const, runId: "fresh", createdAt: "2026-08-13T00:00:00.000Z", seed: 1,
    baselineSha: "c".repeat(40), runRoot: fixture.input.runRoot, sourceRoot: join(fixture.root, "private-source"),
    harnessRoot: join(fixture.root, "private-harness"), provenanceJsonlPath: join(fixture.root, "private-authority.jsonl"),
    tracks: ["controlled" as const], fixtures: [{ id: "direct-cold" as const, version: "v1", sha256: "f".repeat(64), promptCount: 1 }], arms: [arm] };
  const runtimeIdentity = benchmarkPlanIdentity(plan);
  const manifestIdentity = benchmarkPlanIdentity(redactBenchmarkPlan(plan));
  expect(runtimeIdentity).toBe(manifestIdentity);
  expect(runtimeIdentity).not.toBe(historicalManifestIdentity);
  expect(runtimeIdentity).not.toBe(historicalRuntimeIdentity);
  const relocated = { ...plan, runRoot: join(fixture.root, "other-run"), sourceRoot: join(fixture.root, "other-source"),
    harnessRoot: join(fixture.root, "other-harness"), provenanceJsonlPath: join(fixture.root, "other.jsonl"),
    arms: [{ ...arm, sourceRoot: join(fixture.root, "other-source"), outputRoot: join(fixture.root, "other-run/arms/one/output"),
      dataRoot: join(fixture.root, "other-run/arms/one/data"), evidenceRoot: join(fixture.root, "other-run/arms/one/evidence"), cacheRoot: join(fixture.root, "other-run/cache/one") }] };
  expect(benchmarkPlanIdentity(relocated)).toBe(runtimeIdentity);
});

test("immutable failed Attempt -03 fixture reproduces the exact persisted identity split without promotion", () => {
  const manifestText = JSON.stringify(failedAttemptManifest);
  const identitiesText = JSON.stringify(failedAttemptIdentities);
  expect(benchmarkPlanIdentity(failedAttemptManifest as never)).toBe(failedAttemptIdentities.manifestSemanticPlanIdentity);
  expect(failedAttemptIdentities.runtimeResultPlanIdentity).toBe(failedAttemptIdentities.beforeReceiptPlanIdentity);
  expect(failedAttemptIdentities.runtimeResultPlanIdentity).toBe(failedAttemptIdentities.afterReceiptPlanIdentity);
  expect(failedAttemptIdentities.runtimeResultPlanIdentity).not.toBe(failedAttemptIdentities.manifestSemanticPlanIdentity);
  expect(failedAttemptIdentities).toMatchObject({ provenance: "immutable-redacted-failed-attempt-03-evidence-copy", promoted: false });
  for (const text of [manifestText, identitiesText]) {
    expect(text).not.toMatch(/\/(?:Users|home|private|var\/folders)\//u);
    expect(text).not.toMatch(/(?:authorization|credential|secret|rawPrompt|rawToolPayload|transcript|responseBody)/iu);
  }
});

test("non-Agent physical identity fails closed on digest and fabricated SC01 evidence", () => {
  const missing = exportFixture(); missing.input.providerRequests[1]!.attemptDigest = null;
  expect(() => materializeM1V2EvidenceExport(missing.input)).toThrow("attempt_digest_invalid");

  const crossRole = exportFixture(); crossRole.input.providerRequests[1]!.attemptDigest = "A".repeat(43);
  expect(() => materializeM1V2EvidenceExport(crossRole.input)).toThrow();

  const fabricatedSegment = exportFixture();
  fabricatedSegment.input.metrics.push({ ...fabricatedSegment.input.metrics[1]!, dimensions: {
    ...fabricatedSegment.input.metrics[1]!.dimensions!, attemptDigest: "B".repeat(43), segmentId: "non-agent-segment",
  } });
  expect(() => materializeM1V2EvidenceExport(fabricatedSegment.input)).toThrow("non_agent_partial_telemetry");

  const armTagged = exportFixture();
  armTagged.input.metrics.push({ ...armTagged.input.metrics[0]!, dimensions: {
    ...armTagged.input.metrics[0]!.dimensions!, attemptDigest: "B".repeat(43), providerSendBytes: 20,
  } });
  expect(() => materializeM1V2EvidenceExport(armTagged.input)).toThrow("arm_tagged_non_agent_rejected");
});

test("physical request identity fails closed on role, owner, ordinal, bytes, status, and timing drift", () => {
  const mutations: Array<[string, (fixture: ReturnType<typeof exportFixture>) => void]> = [
    ["role", (fixture) => { fixture.input.providerRequests[1]!.requestKind = "auxiliary"; }],
    ["turn", (fixture) => { (fixture.input.target.providerRequestIdentities as Record<string, unknown>[])[1]!.turnId = "turn-other"; }],
    ["ordinal", (fixture) => { fixture.input.providerRequests[1]!.ordinal = 1; }],
    ["bytes", (fixture) => { fixture.input.providerRequests[0]!.serializedRequestBytes = 101; }],
    ["status", (fixture) => { fixture.input.providerRequests[1]!.status = 99; }],
    ["timing", (fixture) => { fixture.input.providerRequests[1]!.terminatedAtMs = 1; }],
  ];
  for (const [, mutate] of mutations) {
    const fixture = exportFixture(); mutate(fixture);
    expect(() => materializeM1V2EvidenceExport(fixture.input)).toThrow();
  }
});

test("durable overhead tamper fails closed on terminal, provider status, and effective tier", () => {
  for (const mutate of [
    (row: Record<string, unknown>) => { row.terminalStatus = "pending"; },
    (row: Record<string, unknown>) => { row.providerStatus = 99; },
    (row: Record<string, unknown>) => { row.effectiveServiceTierAvailability = "unavailable"; },
    (row: Record<string, unknown>) => { row.effectiveServiceTierReason = "provider_response_omitted"; },
  ]) {
    const fixture = exportFixture(); const output = materializeM1V2EvidenceExport(fixture.input);
    const value = JSON.parse(readFileSync(output.absolutePath, "utf8")) as Record<string, unknown> & { overhead: Record<string, unknown>[]; contentSha256: string };
    mutate(value.overhead[0]!);
    value.contentSha256 = createHash("sha256").update(JSON.stringify({ ...value, contentSha256: "" })).digest("hex");
    writeFileSync(output.absolutePath, `${JSON.stringify(value, null, 2)}\n`);
    expect(() => verifyM1V2EvidenceExport({ path: output.absolutePath, expected: output.evidence.identity })).toThrow();
  }
});

test("durable reopen rejects ownership inversion and cross-role digest tamper with a recomputed hash", () => {
  const mutations: Array<(value: DurableFixtureValue) => void> = [
    (value) => { value.overhead[0]!.sessionId = "session-other"; },
    (value) => { value.overhead[0]!.attemptDigest = value.attempts[0]!.attemptDigest; },
    (value) => { value.attempts[0]!.ownership = "other_step"; },
  ];
  for (const mutate of mutations) {
    const fixture = exportFixture(); const output = materializeM1V2EvidenceExport(fixture.input);
    rewriteDurableEvidence(output.absolutePath, mutate);
    expect(() => verifyM1V2EvidenceExport({ path: output.absolutePath, expected: output.evidence.identity })).toThrow();
  }
});

test("external membership identity rejects fully rewritten primary and retry ownership", () => {
  const retryDigest = "R".repeat(43);
  for (const index of [0, 1]) {
    const copy = exportFixture();
    copy.input.providerRequests.push({ ...copy.input.providerRequests[0]!, ordinal: 3, attemptDigest: retryDigest, requestStartedAtMs: 210, completedAtMs: 230, terminatedAtMs: 230 });
    (copy.input.target.providerRequestIdentities as Record<string, unknown>[]).push({ ordinal: 3, sessionId: copy.input.identity.sessionId,
      turnId: copy.input.identity.turnId, requestKind: "agent", physicalAttemptDigest: retryDigest });
    copy.input.metrics.push(...copy.input.metrics.slice(0, 4).map((row) => ({ ...row, ts: 230, dimensions: { ...row.dimensions, attemptDigest: retryDigest,
      ...(row.name === "m1_v2_request_envelope" ? { retryOrdinal: 1, eligibility: "retry_contaminated" } : {}) } })));
    const copyOutput = materializeM1V2EvidenceExport(copy.input);
    rewriteDurableEvidence(copyOutput.absolutePath, (value) => {
      const row = value.attempts[index]!;
      row.ownership = "other_step"; row.stepId = "other-step"; row.sessionId = "other-session"; row.turnId = "other-turn";
      row.envelope.retryOrdinal = 0; row.envelope.eligibility = "usage_unavailable";
    }, true);
    expect(() => verifyM1V2EvidenceExport({ path: copyOutput.absolutePath, expected: copyOutput.evidence.identity })).toThrow("identity_mismatch");
  }
});

test("durable reopen rejects envelope timing and terminal status drift", () => {
  for (const mutate of [
    (value: DurableFixtureValue) => { value.attempts[0]!.envelope.observedAtMs = value.attempts[0]!.terminatedAtMs + 5_001; },
    (value: DurableFixtureValue) => { value.attempts[0]!.providerStatus = 500; },
  ]) {
    const fixture = exportFixture(); const output = materializeM1V2EvidenceExport(fixture.input);
    rewriteDurableEvidence(output.absolutePath, mutate);
    expect(() => verifyM1V2EvidenceExport({ path: output.absolutePath, expected: output.evidence.identity })).toThrow();
  }
});

test("durable retries require exact contiguous ordinals and contaminated eligibility", () => {
  const fixture = exportFixture(); const retryDigest = "R".repeat(43);
  fixture.input.providerRequests.push({ ...fixture.input.providerRequests[0]!, ordinal: 3, attemptDigest: retryDigest, requestStartedAtMs: 210, completedAtMs: 230, terminatedAtMs: 230 });
  (fixture.input.target.providerRequestIdentities as Record<string, unknown>[]).push({ ordinal: 3, sessionId: fixture.input.identity.sessionId,
    turnId: fixture.input.identity.turnId, requestKind: "agent", physicalAttemptDigest: retryDigest });
  fixture.input.metrics.push(...fixture.input.metrics.slice(0, 4).map((row) => ({ ...row, ts: 230, dimensions: { ...row.dimensions, attemptDigest: retryDigest,
    ...(row.name === "m1_v2_request_envelope" ? { retryOrdinal: 1, eligibility: "retry_contaminated" } : {}) } })));
  const output = materializeM1V2EvidenceExport(fixture.input);
  expect(output.evidence.attempts.map((row) => row.envelope.retryOrdinal)).toEqual([0, 1]);

  for (const mutate of [
    (value: DurableFixtureValue) => { value.attempts[1]!.envelope.retryOrdinal = 0; },
    (value: DurableFixtureValue) => { value.attempts[1]!.envelope.retryOrdinal = 2; },
    (value: DurableFixtureValue) => { value.attempts[1]!.envelope.eligibility = "usage_unavailable"; },
  ]) {
    const tampered = exportFixture();
    tampered.input.providerRequests.push({ ...tampered.input.providerRequests[0]!, ordinal: 3, attemptDigest: retryDigest, requestStartedAtMs: 210, completedAtMs: 230, terminatedAtMs: 230 });
    (tampered.input.target.providerRequestIdentities as Record<string, unknown>[]).push({ ordinal: 3, sessionId: tampered.input.identity.sessionId,
      turnId: tampered.input.identity.turnId, requestKind: "agent", physicalAttemptDigest: retryDigest });
    tampered.input.metrics.push(...tampered.input.metrics.slice(0, 4).map((row) => ({ ...row, ts: 230, dimensions: { ...row.dimensions, attemptDigest: retryDigest,
      ...(row.name === "m1_v2_request_envelope" ? { retryOrdinal: 1, eligibility: "retry_contaminated" } : {}) } })));
    const tamperedOutput = materializeM1V2EvidenceExport(tampered.input);
    rewriteDurableEvidence(tamperedOutput.absolutePath, mutate);
    expect(() => verifyM1V2EvidenceExport({ path: tamperedOutput.absolutePath, expected: tamperedOutput.evidence.identity })).toThrow();
  }
});

test("failed physical attempt without canonical usage stays explicit unavailable before successful retry", () => {
  const fixture = exportFixture(); const retryDigest = "R".repeat(43);
  fixture.input.metrics[0]!.dimensions!.eligibility = "rejected";
  fixture.input.metrics.splice(3, 1);
  fixture.input.providerRequests[0]!.termination = "failed"; Object.assign(fixture.input.providerRequests[0]!, { completedAtMs: null }); fixture.input.providerRequests[0]!.status = 500;
  fixture.input.providerRequests.push({ ...fixture.input.providerRequests[0]!, ordinal: 3, attemptDigest: retryDigest, termination: "completed", completedAtMs: 203, terminatedAtMs: 203, status: 200 });
  (fixture.input.target.providerRequestIdentities as Record<string, unknown>[]).push({ ordinal: 3, sessionId: fixture.input.identity.sessionId,
    turnId: fixture.input.identity.turnId, requestKind: "agent", physicalAttemptDigest: retryDigest });
  fixture.input.metrics.push(...exportFixture().input.metrics.map((row) => ({ ...row, dimensions: { ...row.dimensions, attemptDigest: retryDigest,
    ...(row.name === "m1_v2_request_envelope" ? { retryOrdinal: 1, eligibility: "retry_contaminated" } : {}) } })));
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
    { ordinal: 3, sessionId: "session-warmup", turnId: "turn-warmup", requestKind: "agent", physicalAttemptDigest: warmupDigest },
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
    { ordinal: 3, sessionId: "session-safe", turnId: "turn-warmup", requestKind: "agent", physicalAttemptDigest: digest },
  ] });
  expect(() => materializeM1V2EvidenceExport(fixture.input)).toThrow("membership_owner_identity_mismatch");
});

test("SC01 rejects missing and unknown same-arm Agent ownership", () => {
  const missing = exportFixture(); missing.input.observations.push({ stepId: "warmup", sessionId: "session-warmup", turnId: "turn-warmup", providerRequestIdentities: [
    { ordinal: 3, sessionId: "session-warmup", turnId: "turn-warmup", requestKind: "agent", physicalAttemptDigest: "W".repeat(43) },
  ] });
  missing.input.providerRequests.push({ ...missing.input.providerRequests[0]!, ordinal: 3, attemptDigest: "W".repeat(43) });
  expect(() => materializeM1V2EvidenceExport(missing.input)).toThrow("membership_incomplete");
  const extra = exportFixture(); extra.input.metrics.unshift(...extra.input.metrics.slice(0, 4).map((row) => ({ ...row, dimensions: { ...row.dimensions, attemptDigest: "X".repeat(43) } })));
  expect(() => materializeM1V2EvidenceExport(extra.input)).toThrow("unknown_physical_telemetry");
  const orphanRequest = exportFixture(); orphanRequest.input.providerRequests.push({ ...orphanRequest.input.providerRequests[0]!, ordinal: 4, attemptDigest: null });
  expect(() => materializeM1V2EvidenceExport(orphanRequest.input)).toThrow("attempt_digest_invalid");
  const missingOverhead = exportFixture(); missingOverhead.input.providerRequests.splice(1, 1);
  expect(() => materializeM1V2EvidenceExport(missingOverhead.input)).toThrow("non_agent_membership_incomplete");
});

test("SC01 publication rejects a symlinked evidence root", () => {
  const fixture = exportFixture(); const external = mkdtempSync(join(tmpdir(), "sc01-external-")); const link = join(fixture.input.runRoot, "linked-evidence");
  symlinkSync(external, link); fixture.input.evidenceRoot = link;
  expect(() => materializeM1V2EvidenceExport(fixture.input)).toThrow("symlink_rejected");
});

test("durable authority precedes evidence publication and makes a write failure retryable", () => {
  const fixture = exportFixture();
  const evidencePath = join(fixture.input.evidenceRoot, "sc01-public-evidence.json");
  mkdirSync(evidencePath);
  expect(() => materializeM1V2EvidenceExport(fixture.input)).toThrow();
  expect(readdirSync(join(fixture.input.runRoot, ".sc01-durable-authority"))).toHaveLength(1);
  rmSync(evidencePath, { recursive: true });
  expect(materializeM1V2EvidenceExport(fixture.input).evidence.attempts).toHaveLength(1);
});

test("durable authority publication rejects a pre-positioned symlink", () => {
  const fixture = exportFixture(); const external = mkdtempSync(join(tmpdir(), "sc01-authority-external-"));
  symlinkSync(external, join(fixture.input.runRoot, ".sc01-durable-authority"));
  expect(() => materializeM1V2EvidenceExport(fixture.input)).toThrow("authority_symlink_rejected");
  expect(readdirSync(external)).toEqual([]);
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
  const digest = "A".repeat(43); const titleDigest = "B".repeat(43); const sessionId = "session-safe"; const turnId = "turn-safe";
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
    { ordinal: 1, sessionId, turnId, requestKind: "agent", physicalAttemptDigest: digest },
    { ordinal: 2, sessionId, turnId, requestKind: "title", physicalAttemptDigest: titleDigest },
  ] };
  const evidence = { run: { dataRoot } };
  const arm = { evidenceRoot, outputRoot: join(runRoot, "output"), cacheRoot: join(runRoot, "cache"), dataRoot: join(runRoot, "declared-data"), sourceRoot: join(root, "source") };
  return { root, dataRoot, evidence, arm, input: { runRoot, evidenceRoot, identity: { planIdentity: "a".repeat(64), sourceRevision: "c".repeat(40), fixtureHash: "f".repeat(64),
    armKey: "direct-cold:before", armId: "direct-cold" as const, repetition: 1, block: 1, stepId: "target",
    version: "before" as const, pairId: "pair-1", armOrder: 0, sessionId, turnId, expectedProviderId: "openai-codex" as const,
    expectedModelRef: "openai/gpt-5.6-sol", expectedRouteId: "openai-codex-responses" as const, expectedCacheBoundaryRevision: "current", membershipSha256: null },
    target, observations: [target], providerRequests: [provider(1, "agent", 100, digest), provider(2, "title", 20, titleDigest)], metrics } };
}

type DurableFixtureValue = {
  identity: { membershipSha256: string | null };
  attempts: Array<{ ownership: string; stepId: string; sessionId: string; turnId: string; role: string; ordinal: number; attemptDigest: string; terminatedAtMs: number; providerStatus: number | null; envelope: Record<string, unknown> }>;
  overhead: Array<{ sessionId: string | null; attemptDigest: string }>;
  contentSha256: string;
};

function rewriteDurableEvidence(path: string, mutate: (value: DurableFixtureValue) => void, rewriteMembership = false): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as DurableFixtureValue;
  mutate(value);
  if (rewriteMembership) value.identity.membershipSha256 = createHash("sha256").update(JSON.stringify([...value.attempts, ...value.overhead].map((row) => ({
    ordinal: (row as { ordinal?: number }).ordinal, role: (row as { role?: string }).role, ownership: (row as { ownership?: string }).ownership,
    stepId: (row as { stepId?: string | null }).stepId, sessionId: row.sessionId, turnId: (row as { turnId?: string | null }).turnId,
    physicalAttemptDigest: row.attemptDigest,
  })))).digest("hex");
  value.contentSha256 = createHash("sha256").update(JSON.stringify({ ...value, contentSha256: "" })).digest("hex");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
