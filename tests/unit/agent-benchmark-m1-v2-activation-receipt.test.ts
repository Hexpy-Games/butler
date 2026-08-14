import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { materializeM1V2RuntimeActivationReceipt } from "../support/agent-benchmark/m1-v2-activation-receipt.ts";
import { FINAL_ACTIVATION, FINAL_AFTER_REVISION, FINAL_BEFORE_REVISION } from "../support/agent-benchmark/paired-contract.ts";
import { AFTER_ONLY_AFTER_REVISION } from "../support/agent-benchmark/after-only-contract.ts";
import type { ProviderRequestObservation } from "../e2e/btcc-r3-electron/provider-observation-proxy.ts";

const OFF_ACTIVATION = { ...FINAL_ACTIVATION.before, mode: "off" as const,
  toolInstructionSurface: false, exactOnceReplay: false, boundedStatelessContext: false };

test("runtime receipt combines final serializer and admitted canonical after state", () => {
  withRoot((root) => {
    seed(root, true);
    const receipt = materializeM1V2RuntimeActivationReceipt({ runRoot: root, dataRoot: join(root, "data"), evidenceRoot: join(root, "evidence"),
      turnId: "turn-1", version: "after", sourceRevision: FINAL_AFTER_REVISION,
      declaredActivation: FINAL_ACTIVATION.after, providerRequests: [request(true)] });
    expect(receipt).toMatchObject({ policyMode: "phase_minimal", policyRevision: "butler.btcc-tool-instruction-policy.v1",
      exactReplay: { enabled: true, referenceSchemaOwner: "butler.operation-result-reference.v1" },
      continuation: { admitted: true, schema: "butler.turn-continuation-budget.v2",
        limits: { maxModelFacingBytes: 196_608 } }, stablePrefixRevision: "butler.btcc-stable-provider-prefix.v1",
      finalSerializer: "butler.openai-codex-final-json.v1", rawTextStored: false });
    expect(existsSync(join(root, "evidence", "m1-v2-runtime-activation-receipt.json"))).toBe(true);
    expect(materializeM1V2RuntimeActivationReceipt({ runRoot: root, dataRoot: join(root, "data"), evidenceRoot: join(root, "evidence"),
      turnId: "turn-1", version: "after", sourceRevision: FINAL_AFTER_REVISION,
      declaredActivation: FINAL_ACTIVATION.after, providerRequests: [request(true)] })).toEqual(receipt);
    const target = join(root, "evidence", "m1-v2-runtime-activation-receipt.json");
    writeFileSync(target, readFileSync(target, "utf8").replace('"rawTextStored": false', '"rawTextStored": true'));
    expect(() => materializeM1V2RuntimeActivationReceipt({ runRoot: root, dataRoot: join(root, "data"), evidenceRoot: join(root, "evidence"),
      turnId: "turn-1", version: "after", sourceRevision: FINAL_AFTER_REVISION,
      declaredActivation: FINAL_ACTIVATION.after, providerRequests: [request(true)] })).toThrow("existing_target_conflict");
  });
});

test("runtime receipt accepts exact AFTER-only ON identity and rejects OFF or version drift", () => {
  withRoot((root) => {
    seed(root, true);
    const base = { runRoot: root, dataRoot: join(root, "data"), evidenceRoot: join(root, "after-only"),
      turnId: "turn-1", version: "after" as const, sourceRevision: AFTER_ONLY_AFTER_REVISION,
      declaredActivation: FINAL_ACTIVATION.after, providerRequests: [request(true)] };
    const receipt = materializeM1V2RuntimeActivationReceipt(base);
    expect(receipt).toMatchObject({ version: "after", sourceRevision: AFTER_ONLY_AFTER_REVISION,
      declaredActivation: { mode: "on", toolInstructionSurface: true, exactOnceReplay: true,
        boundedStatelessContext: true }, policyMode: "phase_minimal" });
    expect(() => materializeM1V2RuntimeActivationReceipt({ ...base, evidenceRoot: join(root, "off-drift"),
      declaredActivation: OFF_ACTIVATION })).toThrow("declared_identity_mismatch");
    expect(() => materializeM1V2RuntimeActivationReceipt({ ...base, evidenceRoot: join(root, "version-drift"),
      version: "before", declaredActivation: OFF_ACTIVATION })).toThrow("declared_identity_mismatch");
  });
});

test("runtime receipt rejects temp conflicts, declaration drift, mixed after schema, and extra limits", () => {
  withRoot((root) => {
    seed(root, true);
    const base = { runRoot: root, dataRoot: join(root, "data"), evidenceRoot: join(root, "evidence"), turnId: "turn-1",
      version: "after" as const, sourceRevision: FINAL_AFTER_REVISION,
      declaredActivation: FINAL_ACTIVATION.after, providerRequests: [request(true)] };
    mkdirSync(base.evidenceRoot, { recursive: true });
    writeFileSync(join(base.evidenceRoot, "m1-v2-runtime-activation-receipt.json.tmp"), "conflict");
    expect(() => materializeM1V2RuntimeActivationReceipt(base)).toThrow();
    rmSync(join(base.evidenceRoot, "m1-v2-runtime-activation-receipt.json.tmp"));
    expect(() => materializeM1V2RuntimeActivationReceipt({ ...base, sourceRevision: FINAL_BEFORE_REVISION }))
      .toThrow("declared_identity_mismatch");
    expect(() => materializeM1V2RuntimeActivationReceipt({ ...base, providerRequests: [request(true), request(false)] }))
      .toThrow("runtime_path_legacy");
    const db = new Database(join(root, "data", "runtime", "conversation.sqlite"));
    const row = db.query<{ continuation_budget_json: string }, []>("SELECT continuation_budget_json FROM btcc_turns").get()!;
    const state = JSON.parse(row.continuation_budget_json); state.limits.testOnly = 1;
    db.query("UPDATE btcc_turns SET continuation_budget_json = ?").run(JSON.stringify(state)); db.close();
    expect(() => materializeM1V2RuntimeActivationReceipt(base)).toThrow("runtime_path_legacy");
  });
});

test("runtime receipt requires the admitted canonical M1 path for both paired sources", () => {
  withRoot((root) => {
    seed(root, false);
    expect(() => materializeM1V2RuntimeActivationReceipt({ runRoot: root, dataRoot: join(root, "data"), evidenceRoot: join(root, "after"),
      turnId: "turn-1", version: "after", sourceRevision: FINAL_AFTER_REVISION,
      declaredActivation: FINAL_ACTIVATION.after, providerRequests: [request(false)] }))
      .toThrow("m1_activation_flags_enabled_but_runtime_path_legacy");
    expect(() => materializeM1V2RuntimeActivationReceipt({ runRoot: root, dataRoot: join(root, "data"), evidenceRoot: join(root, "before"),
      turnId: "turn-1", version: "before", sourceRevision: FINAL_BEFORE_REVISION,
      declaredActivation: FINAL_ACTIVATION.before, providerRequests: [request(false)] }))
      .toThrow("m1_activation_flags_enabled_but_runtime_path_legacy");
  });
  withRoot((root) => {
    seed(root, true);
    const receipt = materializeM1V2RuntimeActivationReceipt({ runRoot: root, dataRoot: join(root, "data"), evidenceRoot: join(root, "before"),
      turnId: "turn-1", version: "before", sourceRevision: FINAL_BEFORE_REVISION,
      declaredActivation: FINAL_ACTIVATION.before, providerRequests: [request(true)] });
    expect(receipt).toMatchObject({ policyMode: "phase_minimal", continuation: { admitted: true }, exactReplay: { enabled: true } });
  });
});

test("runtime receipt rejects actual route/cache identity drift", () => {
  withRoot((root) => {
    seed(root, true); const db = new Database(join(root, "data", "runtime", "conversation.sqlite"));
    const row = db.query<{ normalized_response_json: string }, []>("SELECT normalized_response_json FROM btcc_model_round_acceptances").get()!;
    const normalized = JSON.parse(row.normalized_response_json); normalized.continuation.providerRouteIdentity.modelRef = "gpt-drift";
    db.query("UPDATE btcc_model_round_acceptances SET normalized_response_json = ?").run(JSON.stringify(normalized)); db.close();
    expect(() => materializeM1V2RuntimeActivationReceipt({ runRoot: root, dataRoot: join(root, "data"), evidenceRoot: join(root, "evidence"),
      turnId: "turn-1", version: "after", sourceRevision: FINAL_AFTER_REVISION,
      declaredActivation: FINAL_ACTIVATION.after, providerRequests: [request(true)] })).toThrow("runtime_path_legacy");
  });
});

test("runtime receipt rejects an ancestor symlink and out-of-run evidence root", () => {
  withRoot((root) => {
    seed(root, true); const external = mkdtempSync(join(tmpdir(), "activation-external-"));
    symlinkSync(external, join(root, "linked"));
    const input = { runRoot: root, dataRoot: join(root, "data"), evidenceRoot: join(root, "linked", "evidence"),
      turnId: "turn-1", version: "after" as const, sourceRevision: FINAL_AFTER_REVISION,
      declaredActivation: FINAL_ACTIVATION.after, providerRequests: [request(true)] };
    expect(() => materializeM1V2RuntimeActivationReceipt(input)).toThrow("evidence_root_invalid");
    expect(() => materializeM1V2RuntimeActivationReceipt({ ...input, evidenceRoot: join(external, "outside") }))
      .toThrow("evidence_root_invalid");
    rmSync(external, { recursive: true, force: true });
  });
});

function seed(root: string, after: boolean): void {
  const data = join(root, "data", "runtime"); mkdirSync(data, { recursive: true });
  const db = new Database(join(data, "conversation.sqlite"));
  db.run("CREATE TABLE btcc_turns (turn_id TEXT PRIMARY KEY, continuation_budget_json TEXT)");
  db.run("CREATE TABLE btcc_model_round_acceptances (turn_id TEXT, normalized_response_json TEXT, created_at TEXT)");
  const limits = { maxModelRequests: 60, maxToolRounds: 60, maxModelFacingBytes: 196_608,
    maxCumulativeModelFacingBytes: 8_388_608, maxOutputBytes: 524_288, maxElapsedMs: 7_200_000, maxIdleMs: 1_200_000 };
  db.query("INSERT INTO btcc_turns VALUES (?, ?)").run("turn-1", after ? JSON.stringify({ schemaVersion: "butler.turn-continuation-budget.v2", limits }) : null);
  if (after) db.query("INSERT INTO btcc_model_round_acceptances VALUES (?, ?, ?)").run("turn-1", JSON.stringify({ toolCalls: [], continuation: {
    providerRouteIdentity: { schemaVersion: "butler.provider-route-cache-identity.v1", routeDigest: "d".repeat(64), routeCursor: 0,
      providerId: "openai-codex", modelRef: "openai/gpt-5.6-sol", authMode: "codex_oauth", capabilityDigest: "c".repeat(64),
      toolProfileRevision: "butler.btcc-tool-instruction-policy.v1", stablePrefixRevision: "butler.btcc-stable-provider-prefix.v1",
      serializerContract: "butler.openai-codex-final-json.v1", serializedStablePrefixSha256: "e".repeat(64), serializedStablePrefixBytes: 100 } } }), "2026-08-13T00:00:00.000Z");
  db.close();
}
function request(exact: boolean): ProviderRequestObservation { return { ordinal: 1, attemptDigest: null, requestKind: "agent",
  requestedModel: "gpt-5.6-sol", requestedServiceTierMode: "auto_by_omission", routeId: "openai-codex-responses",
  requestStartedAtMs: 1, serializedRequestBytes: 1, serializedRequestDigest: null, serializedRequestDigestAlgorithm: null,
  serializerContract: "butler.openai-codex-final-json.v1", exactResultReadSchemaObserved: exact,
  firstContentBearingDeltaAtMs: null, completedAtMs: 2, terminatedAtMs: 2, termination: "completed", status: 200,
  hasTextContent: true, hasToolArgumentContent: false, hasReasoningContent: false, streamedTextChars: 1, finalTextChars: 1,
  providerReportedModel: "gpt-5.6-sol", effectiveServiceTierAvailability: "reported", effectiveServiceTierReason: "provider_response_reported" }; }
function withRoot(run: (root: string) => void): void { const root = mkdtempSync(join(tmpdir(), "m1-activation-")); try { run(root); } finally { rmSync(root, { recursive: true, force: true }); } }
